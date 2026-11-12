mod commands;
mod creating;
mod db;
mod dropping;
mod edit;
mod export;
mod files;
mod import;
mod models;
mod mongo;
mod profiles;
mod schema;
mod secrets;
mod sqlscan;
mod tunnel;
#[cfg(test)]
mod testing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Sessions::default())
        .manage(files::ApprovedPaths::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::reset_app_data,
            commands::test_connection,
            commands::connect_profile,
            commands::disconnect,
            commands::reconnect_profile,
            commands::disconnect_profile,
            commands::set_read_only,
            commands::cancel_query,
            commands::list_databases,
            commands::completion_schema,
            commands::list_schemas,
            commands::list_relations,
            commands::list_columns,
            commands::table_data,
            commands::count_rows,
            commands::run_sql,
            commands::export_table,
            commands::export_sql,
            commands::preview_changes,
            commands::apply_changes,
            commands::run_sql_dry,
            commands::search_objects,
            commands::table_structure,
            commands::object_ddl,
            commands::completion_fks,
            commands::import_rows,
            commands::drop_object,
            commands::drop_database,
            commands::create_database,
            commands::open_text_file,
            commands::save_text_file,
            commands::mongo_connect,
            commands::mongo_disconnect,
            commands::mongo_list_databases,
            commands::mongo_list_collections,
            commands::mongo_find,
            commands::mongo_count,
            commands::mongo_estimated_count,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Hyrax");
}
