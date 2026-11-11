use std::collections::HashMap;

use tokio_postgres::Client;

use crate::db::{err, quote_ident, quote_literal};
use crate::models::*;

const SYSTEM_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog','information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

pub const MAX_OBJECTS: i64 = 20_000;
pub const MAX_COMPLETION_FKS: i64 = 5_000;

pub fn kind_label(relkind: &str) -> &'static str {
    match relkind {
        "r" | "p" => "table",
        "v" => "view",
        "m" => "matview",
        "f" => "foreign",
        "S" => "sequence",
        _ => "other",
    }
}

pub fn fk_action(code: &str) -> &'static str {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
}

pub async fn search_objects(client: &Client) -> Result<Vec<ObjectRef>, String> {
    let sql = format!(
        "SELECT n.nspname::text, c.relname::text, c.relkind::text, NULL::text, c.oid \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('r','p','v','m','f','S') AND NOT c.relispartition AND {SYSTEM_SCHEMAS} \
           AND NOT (c.relkind = 'S' AND EXISTS ( \
                SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass \
                AND d.deptype IN ('a','i'))) \
         UNION ALL \
         SELECT n.nspname::text, p.proname::text, \
                CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
                pg_get_function_identity_arguments(p.oid), p.oid \
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.prokind IN ('f','p') AND {SYSTEM_SCHEMAS} \
         ORDER BY 1, 2 LIMIT {MAX_OBJECTS}"
    );
    let rows = client.query(&sql, &[]).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let raw: String = r.get(2);
            let kind = match raw.as_str() {
                "procedure" | "function" => raw.clone(),
                other => kind_label(other).to_string(),
            };
            ObjectRef {
                schema: r.get(0),
                name: r.get(1),
                kind,
                detail: r.get(3),
                oid: r.get(4),
            }
        })
        .collect())
}

struct Relation {
    oid: u32,
    kind: String,
    comment: Option<String>,
    persistence: String,
    partition_key: Option<String>,
}

async fn find_relation(client: &Client, schema: &str, name: &str) -> Result<Relation, String> {
    let rows = client
        .query(
            "SELECT c.oid, c.relkind::text, obj_description(c.oid, 'pg_class'), c.relpersistence::text, \
                    CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f','S')",
            &[&schema, &name],
        )
        .await
        .map_err(err)?;
    let row = rows
        .first()
        .ok_or_else(|| format!("El objeto {schema}.{name} no existe."))?;
    Ok(Relation {
        oid: row.get(0),
        kind: row.get(1),
        comment: row.get(2),
        persistence: row.get(3),
        partition_key: row.get(4),
    })
}

async fn fetch_columns(client: &Client, oid: u32) -> Result<Vec<StructColumn>, String> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid), \
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid \
                            AND i.indisprimary AND a.attnum = ANY(i.indkey)), \
                    a.attidentity::text, a.attgenerated::text, \
                    CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
                         THEN (SELECT co.collname::text FROM pg_collation co WHERE co.oid = a.attcollation) END, \
                    col_description(a.attrelid, a.attnum) \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let identity: String = r.get(5);
            let generated: String = r.get(6);
            StructColumn {
                name: r.get(0),
                data_type: r.get(1),
                nullable: r.get(2),
                default: r.get(3),
                is_primary_key: r.get(4),
                identity: match identity.as_str() {
                    "a" => Some("ALWAYS".to_string()),
                    "d" => Some("BY DEFAULT".to_string()),
                    _ => None,
                },
                generated: !generated.is_empty(),
                collation: r.get(7),
                comment: r.get(8),
            }
        })
        .collect())
}

async fn fetch_indexes(client: &Client, oid: u32) -> Result<Vec<IndexInfo>, String> {
    let rows = client
        .query(
            "SELECT ic.relname::text, pg_get_indexdef(i.indexrelid), i.indisunique, i.indisprimary, \
                    i.indisvalid, pg_relation_size(i.indexrelid), \
                    EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid \
                            AND c.conrelid = i.indrelid AND c.contype IN ('p','u','x')) \
             FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid \
             WHERE i.indrelid = $1 \
             ORDER BY i.indisprimary DESC, ic.relname",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| IndexInfo {
            name: r.get(0),
            definition: r.get(1),
            unique: r.get(2),
            primary: r.get(3),
            valid: r.get(4),
            size_bytes: r.get(5),
            backs_constraint: r.get(6),
        })
        .collect())
}

async fn fetch_constraints(client: &Client, oid: u32) -> Result<Vec<ConstraintInfo>, String> {
    let rows = client
        .query(
            "SELECT c.conname::text, c.contype::text, pg_get_constraintdef(c.oid, true), c.convalidated \
             FROM pg_constraint c \
             WHERE c.conrelid = $1 AND c.contype IN ('p','u','f','c','x') \
             ORDER BY CASE c.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, \
                      c.conname",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let kind: String = r.get(1);
            ConstraintInfo {
                name: r.get(0),
                kind: match kind.as_str() {
                    "p" => "primary",
                    "u" => "unique",
                    "f" => "foreign",
                    "c" => "check",
                    _ => "exclusion",
                }
                .to_string(),
                definition: r.get(2),
                validated: r.get(3),
            }
        })
        .collect())
}

fn fk_select(filter: &str, limit: Option<i64>) -> String {
    format!(
        "SELECT c.conname::text, n.nspname::text, t.relname::text, \
                ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) \
                      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord), \
                rn.nspname::text, rt.relname::text, \
                ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) \
                      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord), \
                c.confupdtype::text, c.confdeltype::text \
         FROM pg_constraint c \
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace \
         WHERE c.contype = 'f' AND c.conparentid = 0 AND {filter} \
         ORDER BY n.nspname, t.relname, c.conname{}",
        limit.map(|l| format!(" LIMIT {l}")).unwrap_or_default()
    )
}

fn to_foreign_key(r: &tokio_postgres::Row) -> ForeignKey {
    let on_update: String = r.get(7);
    let on_delete: String = r.get(8);
    ForeignKey {
        name: r.get(0),
        schema: r.get(1),
        table: r.get(2),
        columns: r.get(3),
        ref_schema: r.get(4),
        ref_table: r.get(5),
        ref_columns: r.get(6),
        on_update: fk_action(&on_update).to_string(),
        on_delete: fk_action(&on_delete).to_string(),
    }
}

async fn fetch_foreign_keys(client: &Client, oid: u32, incoming: bool) -> Result<Vec<ForeignKey>, String> {
    let filter = if incoming { "c.confrelid = $1" } else { "c.conrelid = $1" };
    let rows = client.query(&fk_select(filter, None), &[&oid]).await.map_err(err)?;
    Ok(rows.iter().map(to_foreign_key).collect())
}

async fn fetch_triggers(client: &Client, oid: u32) -> Result<Vec<TriggerInfo>, String> {
    let rows = client
        .query(
            "SELECT t.tgname::text, pg_get_triggerdef(t.oid, true), t.tgenabled::text <> 'D' \
             FROM pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| TriggerInfo {
            name: r.get(0),
            definition: r.get(1),
            enabled: r.get(2),
        })
        .collect())
}

async fn fetch_stats(client: &Client, oid: u32) -> Result<TableStats, String> {
    let row = client
        .query_opt(
            "SELECT c.reltuples::bigint, \
                    CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid) END, \
                    CASE WHEN c.relkind IN ('r','m','p') THEN pg_table_size(c.oid) END, \
                    CASE WHEN c.relkind IN ('r','m','p') THEN pg_indexes_size(c.oid) END, \
                    s.n_dead_tup, \
                    GREATEST(s.last_vacuum, s.last_autovacuum)::text, \
                    GREATEST(s.last_analyze, s.last_autoanalyze)::text, \
                    s.seq_scan, s.idx_scan \
             FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid \
             WHERE c.oid = $1",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(match row {
        None => TableStats::default(),
        Some(r) => {
            let tuples: i64 = r.get(0);
            TableStats {
                estimated_rows: if tuples < 0 { None } else { Some(tuples) },
                total_bytes: r.get(1),
                table_bytes: r.get(2),
                index_bytes: r.get(3),
                dead_tuples: r.get(4),
                last_vacuum: r.get(5),
                last_analyze: r.get(6),
                seq_scans: r.get(7),
                idx_scans: r.get(8),
            }
        }
    })
}

pub async fn table_structure(client: &Client, schema: &str, table: &str) -> Result<TableStructure, String> {
    let rel = find_relation(client, schema, table).await?;
    if rel.kind == "S" {
        return Err("Las secuencias no tienen estructura de tabla.".to_string());
    }
    Ok(TableStructure {
        kind: kind_label(&rel.kind).to_string(),
        comment: rel.comment.clone(),
        columns: fetch_columns(client, rel.oid).await?,
        indexes: fetch_indexes(client, rel.oid).await?,
        constraints: fetch_constraints(client, rel.oid).await?,
        foreign_keys: fetch_foreign_keys(client, rel.oid, false).await?,
        referenced_by: fetch_foreign_keys(client, rel.oid, true).await?,
        triggers: fetch_triggers(client, rel.oid).await?,
        stats: fetch_stats(client, rel.oid).await?,
    })
}

pub async fn completion_fks(client: &Client) -> Result<Vec<ForeignKey>, String> {
    let rows = client
        .query(&fk_select(SYSTEM_SCHEMAS, Some(MAX_COMPLETION_FKS)), &[])
        .await
        .map_err(err)?;
    Ok(rows.iter().map(to_foreign_key).collect())
}

fn strip_semicolon(text: &str) -> &str {
    text.trim().trim_end_matches(';').trim_end()
}

pub fn column_ddl(c: &StructColumn, default_expr: Option<&str>) -> String {
    let mut line = format!("{} {}", quote_ident(&c.name), c.data_type);
    if let Some(collation) = &c.collation {
        line.push_str(&format!(" COLLATE {}", quote_ident(collation)));
    }
    if let Some(identity) = &c.identity {
        line.push_str(&format!(" GENERATED {identity} AS IDENTITY"));
    } else if c.generated {
        if let Some(expr) = default_expr {
            line.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"));
        }
    } else if let Some(expr) = default_expr {
        line.push_str(&format!(" DEFAULT {expr}"));
    }
    if !c.nullable {
        line.push_str(" NOT NULL");
    }
    line
}

async fn relation_extras(
    client: &Client,
    rel: &Relation,
    target: &str,
    columns: &[StructColumn],
    out: &mut Vec<String>,
) -> Result<(), String> {
    let indexes = fetch_indexes(client, rel.oid).await?;
    let loose: Vec<String> = indexes
        .iter()
        .filter(|i| !i.backs_constraint && !i.primary)
        .map(|i| format!("{};", i.definition))
        .collect();
    if !loose.is_empty() {
        out.push(loose.join("\n"));
    }
    let triggers = fetch_triggers(client, rel.oid).await?;
    if !triggers.is_empty() {
        let mut lines = Vec::new();
        for t in &triggers {
            lines.push(format!("{};", t.definition));
            if !t.enabled {
                lines.push(format!("ALTER TABLE {target} DISABLE TRIGGER {};", quote_ident(&t.name)));
            }
        }
        out.push(lines.join("\n"));
    }
    let mut comments = Vec::new();
    if let Some(text) = &rel.comment {
        let what = match rel.kind.as_str() {
            "v" => "VIEW",
            "m" => "MATERIALIZED VIEW",
            "f" => "FOREIGN TABLE",
            _ => "TABLE",
        };
        comments.push(format!("COMMENT ON {what} {target} IS {};", quote_literal(text)));
    }
    for c in columns {
        if let Some(text) = &c.comment {
            comments.push(format!(
                "COMMENT ON COLUMN {target}.{} IS {};",
                quote_ident(&c.name),
                quote_literal(text)
            ));
        }
    }
    if !comments.is_empty() {
        out.push(comments.join("\n"));
    }
    Ok(())
}

async fn default_exprs(client: &Client, oid: u32) -> Result<HashMap<String, String>, String> {
    let rows = client
        .query(
            "SELECT a.attname::text, pg_get_expr(d.adbin, d.adrelid) \
             FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
             WHERE d.adrelid = $1",
            &[&oid],
        )
        .await
        .map_err(err)?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}

pub async fn object_ddl(
    client: &Client,
    schema: &str,
    name: &str,
    kind: &str,
    oid: Option<u32>,
) -> Result<String, String> {
    if kind == "function" || kind == "procedure" {
        let oid = oid.ok_or_else(|| "Falta el identificador de la función.".to_string())?;
        let row = client
            .query_opt(
                "SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid = $1 AND p.prokind IN ('f','p')",
                &[&oid],
            )
            .await
            .map_err(err)?
            .ok_or_else(|| "La función ya no existe.".to_string())?;
        let text: String = row.get(0);
        return Ok(format!("{};\n", text.trim_end()));
    }

    let rel = find_relation(client, schema, name).await?;
    let target = format!("{}.{}", quote_ident(schema), quote_ident(name));

    if rel.kind == "S" {
        let row = client
            .query_one(
                "SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, \
                        s.seqcache, s.seqcycle, \
                        (SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname) || '.' || quote_ident(a.attname) \
                         FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid \
                         JOIN pg_namespace tn ON tn.oid = t.relnamespace \
                         JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                         WHERE d.objid = s.seqrelid AND d.classid = 'pg_class'::regclass AND d.deptype = 'a' LIMIT 1) \
                 FROM pg_sequence s WHERE s.seqrelid = $1",
                &[&rel.oid],
            )
            .await
            .map_err(err)?;
        let ty: String = row.get(0);
        let (start, inc, min, max, cache): (i64, i64, i64, i64, i64) =
            (row.get(1), row.get(2), row.get(3), row.get(4), row.get(5));
        let cycle: bool = row.get(6);
        let owned: Option<String> = row.get(7);
        let mut text = format!(
            "CREATE SEQUENCE {target}\n    AS {ty}\n    INCREMENT BY {inc}\n    MINVALUE {min}\n    MAXVALUE {max}\n    START WITH {start}\n    CACHE {cache}\n    {}",
            if cycle { "CYCLE" } else { "NO CYCLE" }
        );
        if let Some(owner) = owned {
            text.push_str(&format!("\n    OWNED BY {owner}"));
        }
        text.push_str(";\n");
        return Ok(text);
    }

    let columns = fetch_columns(client, rel.oid).await?;
    let mut parts: Vec<String> = Vec::new();

    if rel.kind == "v" || rel.kind == "m" {
        let row = client
            .query_one("SELECT pg_get_viewdef($1::oid, true)", &[&rel.oid])
            .await
            .map_err(err)?;
        let def: String = row.get(0);
        if rel.kind == "v" {
            parts.push(format!("CREATE OR REPLACE VIEW {target} AS\n{};", strip_semicolon(&def)));
        } else {
            let populated: bool = client
                .query_one("SELECT relispopulated FROM pg_class WHERE oid = $1", &[&rel.oid])
                .await
                .map_err(err)?
                .get(0);
            parts.push(format!(
                "CREATE MATERIALIZED VIEW {target} AS\n{}\nWITH {}DATA;",
                strip_semicolon(&def),
                if populated { "" } else { "NO " }
            ));
        }
        relation_extras(client, &rel, &target, &columns, &mut parts).await?;
        return Ok(parts.join("\n\n") + "\n");
    }

    let defaults = default_exprs(client, rel.oid).await?;
    let mut lines: Vec<String> = columns
        .iter()
        .map(|c| format!("    {}", column_ddl(c, defaults.get(&c.name).map(String::as_str))))
        .collect();
    let constraints = fetch_constraints(client, rel.oid).await?;
    for c in &constraints {
        let not_valid = if c.validated || c.kind == "primary" || c.kind == "unique" {
            ""
        } else {
            " NOT VALID"
        };
        lines.push(format!(
            "    CONSTRAINT {} {}{not_valid}",
            quote_ident(&c.name),
            c.definition
        ));
    }
    let head = match rel.kind.as_str() {
        "f" => "CREATE FOREIGN TABLE",
        _ if rel.persistence == "u" => "CREATE UNLOGGED TABLE",
        _ => "CREATE TABLE",
    };
    let mut create = format!("{head} {target} (\n{}\n)", lines.join(",\n"));
    if let Some(key) = &rel.partition_key {
        create.push_str(&format!("\nPARTITION BY {key}"));
    }
    if rel.kind == "f" {
        let row = client
            .query_opt(
                "SELECT s.srvname::text, \
                        ARRAY(SELECT quote_ident(option_name) || ' ' || quote_literal(option_value) \
                              FROM pg_options_to_table(ft.ftoptions)) \
                 FROM pg_foreign_table ft JOIN pg_foreign_server s ON s.oid = ft.ftserver \
                 WHERE ft.ftrelid = $1",
                &[&rel.oid],
            )
            .await
            .map_err(err)?;
        if let Some(r) = row {
            let server: String = r.get(0);
            let options: Vec<String> = r.get(1);
            create.push_str(&format!("\nSERVER {}", quote_ident(&server)));
            if !options.is_empty() {
                create.push_str(&format!("\nOPTIONS ({})", options.join(", ")));
            }
        }
    }
    create.push(';');
    parts.push(create);
    relation_extras(client, &rel, &target, &columns, &mut parts).await?;
    Ok(parts.join("\n\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, nullable: bool) -> StructColumn {
        StructColumn {
            name: name.to_string(),
            data_type: ty.to_string(),
            nullable,
            default: None,
            is_primary_key: false,
            identity: None,
            generated: false,
            collation: None,
            comment: None,
        }
    }

    #[test]
    fn column_ddl_covers_defaults_identity_generated_and_collation() {
        assert_eq!(column_ddl(&col("id", "bigint", false), None), "\"id\" bigint NOT NULL");
        assert_eq!(
            column_ddl(&col("estado", "text", true), Some("'nuevo'::text")),
            "\"estado\" text DEFAULT 'nuevo'::text"
        );
        let mut identity = col("id", "integer", false);
        identity.identity = Some("ALWAYS".to_string());
        assert_eq!(
            column_ddl(&identity, Some("nextval('x')")),
            "\"id\" integer GENERATED ALWAYS AS IDENTITY NOT NULL"
        );
        let mut generated = col("total", "numeric", true);
        generated.generated = true;
        assert_eq!(
            column_ddl(&generated, Some("(a + b)")),
            "\"total\" numeric GENERATED ALWAYS AS ((a + b)) STORED"
        );
        let mut collated = col("nombre", "text", true);
        collated.collation = Some("es_ES".to_string());
        assert_eq!(column_ddl(&collated, None), "\"nombre\" text COLLATE \"es_ES\"");
        assert_eq!(column_ddl(&col("a\"b", "text", true), None), "\"a\"\"b\" text");
    }

    const FIXTURE: &str = "\
        DROP SCHEMA IF EXISTS hyrax_s9 CASCADE; DROP SCHEMA IF EXISTS hyrax_s9_copy CASCADE; \
        CREATE SCHEMA hyrax_s9; CREATE SCHEMA hyrax_s9_copy; \
        CREATE TABLE hyrax_s9.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \
            email text NOT NULL UNIQUE, name text COLLATE \"C\", created timestamptz DEFAULT now()); \
        COMMENT ON TABLE hyrax_s9.customers IS 'Clientes del ''sistema'''; \
        COMMENT ON COLUMN hyrax_s9.customers.email IS 'Correo; único'; \
        CREATE TABLE hyrax_s9.orders (id serial PRIMARY KEY, \
            customer_id bigint NOT NULL REFERENCES hyrax_s9.customers(id) ON DELETE CASCADE ON UPDATE RESTRICT, \
            total numeric(10,2) CHECK (total >= 0), net numeric GENERATED ALWAYS AS (total * 0.8) STORED, tags text[]); \
        CREATE INDEX orders_customer_idx ON hyrax_s9.orders (customer_id); \
        CREATE TABLE hyrax_s9.items (order_id int, line int, PRIMARY KEY (order_id, line), \
            FOREIGN KEY (order_id) REFERENCES hyrax_s9.orders(id)); \
        CREATE VIEW hyrax_s9.v_orders AS SELECT id, total FROM hyrax_s9.orders; \
        CREATE MATERIALIZED VIEW hyrax_s9.mv AS SELECT 1 AS x; \
        CREATE SEQUENCE hyrax_s9.free_seq START 5 INCREMENT 2; \
        CREATE FUNCTION hyrax_s9.double_it(a int) RETURNS int LANGUAGE sql AS 'SELECT a*2'; \
        CREATE FUNCTION hyrax_s9.trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; \
        CREATE TRIGGER orders_trg BEFORE INSERT ON hyrax_s9.orders FOR EACH ROW EXECUTE FUNCTION hyrax_s9.trg();";

    #[tokio::test]
    #[ignore]
    async fn introspects_a_real_schema() {
        use crate::testing::{profile, run};
        let session = crate::db::connect(&profile(false)).await.unwrap();
        run(&session, FIXTURE).await;
        let client = &session.client;

        let objects = search_objects(client).await.unwrap();
        let find = |name: &str| objects.iter().find(|o| o.schema == "hyrax_s9" && o.name == name);
        assert_eq!(find("customers").unwrap().kind, "table");
        assert_eq!(find("v_orders").unwrap().kind, "view");
        assert_eq!(find("mv").unwrap().kind, "matview");
        assert_eq!(find("free_seq").unwrap().kind, "sequence");
        let double = find("double_it").unwrap();
        assert_eq!(double.kind, "function");
        assert_eq!(double.detail.as_deref(), Some("a integer"));
        assert!(find("orders_id_seq").is_none(), "las secuencias de serial/identity no se listan");
        assert!(objects.iter().all(|o| o.schema != "pg_catalog" && o.schema != "information_schema"));

        let orders = table_structure(client, "hyrax_s9", "orders").await.unwrap();
        assert_eq!(orders.kind, "table");
        assert_eq!(orders.columns.len(), 5);
        assert!(orders.columns.iter().find(|c| c.name == "net").unwrap().generated);
        assert!(orders.columns.iter().find(|c| c.name == "id").unwrap().is_primary_key);
        let fk = &orders.foreign_keys[0];
        assert_eq!((fk.columns.clone(), fk.ref_table.as_str(), fk.ref_columns.clone()), (vec!["customer_id".to_string()], "customers", vec!["id".to_string()]));
        assert_eq!((fk.on_delete.as_str(), fk.on_update.as_str()), ("CASCADE", "RESTRICT"));
        assert_eq!(orders.referenced_by.len(), 1);
        assert_eq!(orders.referenced_by[0].table, "items");
        assert!(orders.indexes.iter().any(|i| i.name == "orders_pkey" && i.primary && i.backs_constraint));
        assert!(orders.indexes.iter().any(|i| i.name == "orders_customer_idx" && !i.backs_constraint && i.valid));
        assert!(orders.constraints.iter().any(|c| c.kind == "check"));
        assert_eq!(orders.triggers.len(), 1);
        assert!(orders.stats.total_bytes.unwrap() > 0);

        let customers = table_structure(client, "hyrax_s9", "customers").await.unwrap();
        assert_eq!(customers.comment.as_deref(), Some("Clientes del 'sistema'"));
        assert_eq!(customers.columns[0].identity.as_deref(), Some("ALWAYS"));
        assert_eq!(customers.columns[2].collation.as_deref(), Some("C"));
        assert_eq!(customers.referenced_by[0].table, "orders");

        let items = table_structure(client, "hyrax_s9", "items").await.unwrap();
        assert_eq!(items.columns.iter().filter(|c| c.is_primary_key).count(), 2, "clave compuesta");

        let view = table_structure(client, "hyrax_s9", "v_orders").await.unwrap();
        assert_eq!(view.kind, "view");
        assert!(view.stats.total_bytes.is_none(), "las vistas no tienen tamaño");
        assert!(table_structure(client, "hyrax_s9", "free_seq").await.is_err());
        assert!(table_structure(client, "hyrax_s9", "no_existe").await.unwrap_err().contains("no existe"));

        let fks = completion_fks(client).await.unwrap();
        assert!(fks.iter().any(|f| f.schema == "hyrax_s9" && f.table == "orders" && f.ref_table == "customers"));
        assert!(fks.iter().all(|f| f.schema != "pg_catalog"));
    }

    #[tokio::test]
    #[ignore]
    async fn generated_ddl_is_valid_sql_and_recreates_the_same_structure() {
        use crate::testing::{profile, run, value};
        let session = crate::db::connect(&profile(false)).await.unwrap();
        run(&session, FIXTURE).await;
        let client = &session.client;

        let customers = object_ddl(client, "hyrax_s9", "customers", "table", None).await.unwrap();
        assert!(customers.contains("GENERATED ALWAYS AS IDENTITY"), "{customers}");
        assert!(customers.contains("COLLATE \"C\""), "{customers}");
        assert!(customers.contains("UNIQUE (email)"), "{customers}");
        assert!(customers.contains("COMMENT ON TABLE \"hyrax_s9\".\"customers\" IS 'Clientes del ''sistema'''"), "{customers}");
        assert!(customers.contains("COMMENT ON COLUMN \"hyrax_s9\".\"customers\".\"email\" IS 'Correo; único'"), "{customers}");

        let orders = object_ddl(client, "hyrax_s9", "orders", "table", None).await.unwrap();
        assert!(orders.contains("GENERATED ALWAYS AS ((total * 0.8)) STORED"), "{orders}");
        assert!(orders.contains("FOREIGN KEY (customer_id) REFERENCES hyrax_s9.customers(id) ON UPDATE RESTRICT ON DELETE CASCADE"), "{orders}");
        assert!(orders.contains("CREATE INDEX orders_customer_idx"), "{orders}");
        assert!(orders.contains("CREATE TRIGGER orders_trg"), "{orders}");

        // El DDL debe poder ejecutarse: se recrean las tablas en otro schema y se compara la estructura.
        for table in ["customers", "orders", "items"] {
            let ddl = object_ddl(client, "hyrax_s9", table, "table", None).await.unwrap();
            let moved = ddl.replace(
                &format!("\"hyrax_s9\".\"{table}\""),
                &format!("\"hyrax_s9_copy\".\"{table}\""),
            ).replace(
                &format!("ON hyrax_s9.{table} "),
                &format!("ON hyrax_s9_copy.{table} "),
            ).replace(
                "REFERENCES hyrax_s9.",
                "REFERENCES hyrax_s9_copy.",
            ).replace("ON hyrax_s9.orders ", "ON hyrax_s9_copy.orders ");
            run(&session, &moved).await;
            let original = table_structure(client, "hyrax_s9", table).await.unwrap();
            let copy = table_structure(client, "hyrax_s9_copy", table).await.unwrap();
            let shape = |s: &TableStructure| {
                (
                    s.columns.iter().map(|c| (c.name.clone(), c.data_type.clone(), c.nullable, c.is_primary_key, c.identity.clone(), c.generated, c.collation.clone())).collect::<Vec<_>>(),
                    s.constraints.iter().map(|c| (c.name.clone(), c.kind.clone())).collect::<Vec<_>>(),
                    s.indexes.iter().map(|i| (i.name.clone(), i.unique, i.primary)).collect::<Vec<_>>(),
                    s.triggers.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
                )
            };
            assert_eq!(shape(&original), shape(&copy), "la copia de {table} difiere del original");
        }

        let view = object_ddl(client, "hyrax_s9", "v_orders", "view", None).await.unwrap();
        assert!(view.starts_with("CREATE OR REPLACE VIEW \"hyrax_s9\".\"v_orders\" AS"), "{view}");
        run(&session, &view).await;

        let mv = object_ddl(client, "hyrax_s9", "mv", "matview", None).await.unwrap();
        assert!(mv.starts_with("CREATE MATERIALIZED VIEW \"hyrax_s9\".\"mv\" AS") && mv.contains("WITH DATA;"), "{mv}");
        run(&session, &format!("DROP MATERIALIZED VIEW hyrax_s9.mv; {mv}")).await;

        let seq = object_ddl(client, "hyrax_s9", "free_seq", "sequence", None).await.unwrap();
        assert!(seq.contains("START WITH 5") && seq.contains("INCREMENT BY 2") && seq.contains("NO CYCLE"), "{seq}");
        run(&session, &format!("DROP SEQUENCE hyrax_s9.free_seq; {seq}")).await;
        assert_eq!(value(&session, "SELECT nextval('hyrax_s9.free_seq')").await.as_deref(), Some("5"));

        let oid: u32 = search_objects(client).await.unwrap().iter().find(|o| o.name == "double_it").unwrap().oid;
        let func = object_ddl(client, "hyrax_s9", "double_it", "function", Some(oid)).await.unwrap();
        assert!(func.contains("CREATE OR REPLACE FUNCTION hyrax_s9.double_it"), "{func}");
        run(&session, &func).await;
        assert_eq!(value(&session, "SELECT hyrax_s9.double_it(21)").await.as_deref(), Some("42"));
        assert!(object_ddl(client, "hyrax_s9", "double_it", "function", None).await.is_err());

        run(&session, "DROP SCHEMA hyrax_s9 CASCADE; DROP SCHEMA hyrax_s9_copy CASCADE").await;
    }

    #[test]
    fn maps_catalog_codes() {
        assert_eq!(kind_label("p"), "table");
        assert_eq!(kind_label("m"), "matview");
        assert_eq!(kind_label("S"), "sequence");
        assert_eq!(fk_action("c"), "CASCADE");
        assert_eq!(fk_action("n"), "SET NULL");
        assert_eq!(fk_action("a"), "NO ACTION");
        assert_eq!(strip_semicolon(" SELECT 1 ;\n"), "SELECT 1");
    }
}
