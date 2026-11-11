pub fn code_only(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    let n = chars.len();

    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();

        if c == '-' && next == Some('-') {
            while i < n && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }

        if c == '/' && next == Some('*') {
            let mut depth = 0usize;
            while i < n {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                    i += 1;
                }
            }
            continue;
        }

        if c == '\'' || c == '"' {
            let escapes = c == '\''
                && i > 0
                && matches!(chars[i - 1], 'e' | 'E')
                && (i < 2 || !(chars[i - 2].is_alphanumeric() || chars[i - 2] == '_'));
            out.push(c);
            i += 1;
            while i < n {
                if escapes && chars[i] == '\\' {
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if chars[i] == c {
                    if chars.get(i + 1) == Some(&c) {
                        out.push_str("  ");
                        i += 2;
                        continue;
                    }
                    break;
                }
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            if i < n {
                out.push(c);
                i += 1;
            }
            continue;
        }

        if c == '$' {
            let mut j = i + 1;
            while j < n && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < n && chars[j] == '$' && !(i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')) {
                let tag: String = chars[i..=j].iter().collect();
                let tag_chars: Vec<char> = tag.chars().collect();
                let mut k = j + 1;
                let mut closed = false;
                while k + tag_chars.len() <= n {
                    if chars[k..k + tag_chars.len()] == tag_chars[..] {
                        closed = true;
                        break;
                    }
                    k += 1;
                }
                let end = if closed { k + tag_chars.len() } else { n };
                for ch in &chars[i..end] {
                    out.push(if *ch == '\n' { '\n' } else { ' ' });
                }
                i = end;
                continue;
            }
        }

        out.push(c);
        i += 1;
    }
    out
}

pub fn statements(sql: &str) -> Vec<String> {
    code_only(sql)
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn first_word(statement: &str) -> String {
    statement
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_lowercase()
}

pub fn transaction_control(sql: &str) -> Option<String> {
    const CONTROL: [&str; 8] = ["begin", "start", "commit", "end", "rollback", "abort", "savepoint", "release"];
    for statement in statements(sql) {
        let word = first_word(&statement);
        if CONTROL.contains(&word.as_str()) {
            return Some(word.to_uppercase());
        }
        if word == "prepare" && statement.to_lowercase().contains("transaction") {
            return Some("PREPARE TRANSACTION".to_string());
        }
    }
    None
}

pub fn switches_to_read_write(sql: &str) -> bool {
    let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let raw = squash(&sql.to_lowercase());
    if raw.contains("set_config") {
        return true;
    }
    for statement in statements(sql) {
        let word = first_word(&statement);
        let text = squash(&statement.to_lowercase());
        let touches_mode = |t: &str| t.contains("read_only") || t.contains("read write");
        match word.as_str() {
            "reset" => return true,
            "discard" if text.contains("all") => return true,
            "set" | "begin" | "start" | "alter" if touches_mode(&text) => return true,
            "do" if touches_mode(&raw) => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_strings_and_dollar_quotes() {
        let sql = "SELECT 'a; COMMIT' -- COMMIT;\n, \"x;y\" /* END; /* nested */ COMMIT */ FROM t $$ ; COMMIT $$";
        let code = code_only(sql);
        assert!(!code.contains("COMMIT"));
        assert!(code.contains("SELECT"));
        assert!(code.contains("FROM t"));
        assert_eq!(code.chars().count(), sql.chars().count());
    }

    #[test]
    fn handles_escaped_quotes() {
        assert!(!code_only("SELECT 'it''s COMMIT'").contains("COMMIT"));
        assert!(!code_only("SELECT E'it\\'s COMMIT'").contains("COMMIT"));
        assert!(code_only("SELECT 1; COMMIT").contains("COMMIT"));
    }

    #[test]
    fn detects_attempts_to_leave_read_only_mode() {
        let blocked = [
            "SET default_transaction_read_only = off",
            "set  SESSION default_transaction_read_only TO 'off'",
            "SET transaction_read_only = off",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "BEGIN READ WRITE",
            "START TRANSACTION  READ   WRITE",
            "SELECT set_config('default_transaction_read_only', 'off', false)",
            "RESET ALL",
            "RESET default_transaction_read_only",
            "DISCARD ALL",
            "ALTER ROLE app SET default_transaction_read_only = off",
            "DO $$ BEGIN EXECUTE 'SET default_transaction_read_only = off'; END $$",
            "SELECT 1; SET default_transaction_read_only = off",
        ];
        for sql in blocked {
            assert!(switches_to_read_write(sql), "debió bloquearse: {sql}");
        }
        let allowed = [
            "SELECT 'read_only' AS note, read_only FROM settings",
            "SET search_path = public",
            "SET statement_timeout = 5000",
            "BEGIN",
            "BEGIN READ ONLY",
            "SELECT 'RESET ALL'",
            "-- SET default_transaction_read_only = off\nSELECT 1",
            "DO $$ BEGIN PERFORM 1; END $$",
            "SELECT * FROM discarded_items",
        ];
        for sql in allowed {
            assert!(!switches_to_read_write(sql), "no debió bloquearse: {sql}");
        }
    }

    #[test]
    fn detects_transaction_control_only_at_statement_start() {
        assert_eq!(transaction_control("SELECT 1; COMMIT").as_deref(), Some("COMMIT"));
        assert_eq!(transaction_control("  begin;\nupdate t set a=1").as_deref(), Some("BEGIN"));
        assert_eq!(transaction_control("-- x\nROLLBACK").as_deref(), Some("ROLLBACK"));
        assert_eq!(transaction_control("SAVEPOINT s").as_deref(), Some("SAVEPOINT"));
        assert_eq!(transaction_control("PREPARE TRANSACTION 'x'").as_deref(), Some("PREPARE TRANSACTION"));
        assert_eq!(transaction_control("SELECT CASE WHEN a THEN 1 END FROM t"), None);
        assert_eq!(transaction_control("SELECT 'COMMIT'; UPDATE t SET a = 1"), None);
        assert_eq!(transaction_control("SELECT 1 /* ; COMMIT */"), None);
        assert_eq!(transaction_control("UPDATE t SET note = $x$; COMMIT$x$"), None);
    }
}
