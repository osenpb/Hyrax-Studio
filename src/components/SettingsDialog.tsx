import { LANGS, getLang, setLang, t, useLang, type Lang } from "../i18n";
import Icon from "./Icon";

type Theme = "auto" | "light" | "dark";

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onEraseData: () => void;
  onClose: () => void;
}

export default function SettingsDialog({ theme, onTheme, onEraseData, onClose }: Props) {
  useLang();
  const lang = getLang();
  const themes: { value: Theme; label: string }[] = [
    { value: "auto", label: t("Automático") },
    { value: "light", label: t("Claro") },
    { value: "dark", label: t("Oscuro") },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal small" role="dialog" aria-label={t("Ajustes")} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t("Ajustes")}</h2>

        <label>
          {t("Idioma")}
          <select aria-label={t("Idioma")} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <small className="muted">{t("El idioma se aplica al instante y se recuerda en este equipo.")}</small>
        </label>

        <div className="settings-group" role="group" aria-label={t("Tema")}>
          <span className="settings-label">{t("Tema")}</span>
          <div className="segmented">
            {themes.map((th) => (
              <button key={th.value} className={theme === th.value ? "active" : ""} onClick={() => onTheme(th.value)}>
                {th.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <span className="settings-label">{t("Datos guardados")}</span>
          <button onClick={onEraseData}>
            <Icon name="trash" size={13} /> {t("Borrar conexiones y contraseñas guardadas…")}
          </button>
        </div>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="primary" onClick={onClose}>
            {t("Cerrar")}
          </button>
        </div>
      </div>
    </div>
  );
}
