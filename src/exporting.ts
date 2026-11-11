import { save } from "@tauri-apps/plugin-dialog";
import type { ExportFormat } from "./api";

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: "CSV", extensions: ["csv"] },
  json: { name: "JSON", extensions: ["json"] },
  sql: { name: "SQL", extensions: ["sql"] },
};

export async function askExportPath(baseName: string, format: ExportFormat): Promise<string | null> {
  const safe = baseName.replace(/[\\/:*?"<>|]/g, "_");
  return save({
    title: "Exportar resultado",
    defaultPath: `${safe}.${FILTERS[format].extensions[0]}`,
    filters: [FILTERS[format]],
  });
}
