mod commands;
mod db;
mod export;
mod models;
mod profiles;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::test_connection,
            commands::connect_profile,
            commands::disconnect,
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
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar PgDesk");
}
