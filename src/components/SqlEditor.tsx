import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { ForeignKey, ObjectRef } from "../api";
import { joinSuggestions } from "../joins";
import { snippets } from "../snippets";
import { getLang, useLang } from "../i18n";
import { splitStatements, statementAt } from "../statements";

export interface EditorExtras {
  functions: ObjectRef[];
  fks: ForeignKey[];
}

export interface SqlEditorHandle {
  /** La selección o, si no hay, todo el script. */
  getRunnable: () => string;
  /** La selección o, si no hay, la sentencia donde está el cursor. */
  getStatement: () => string;
  getAll: () => string;
  setText: (text: string) => void;
  transform: (fn: (text: string) => string) => void;
  setSchema: (schema: Record<string, string[]>) => void;
  setExtras: (extras: EditorExtras) => void;
  focus: () => void;
}

interface Props {
  initialValue: string;
  onRun: (all: boolean) => void;
  onFormat: () => void;
  onSave?: () => void;
  readOnly?: boolean;
  fill?: boolean;
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--tok-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--tok-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--tok-number)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.name)], color: "var(--tok-type)" },
  { tag: [t.operator, t.punctuation, t.separator], color: "var(--tok-operator)" },
  { tag: [t.propertyName, t.name], color: "var(--text)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontWeight: "var(--mono-weight)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "none", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--zebra)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-3)", color: "var(--text-soft)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-2)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
    color: "var(--text)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12px", maxHeight: "260px" },
  ".cm-tooltip-autocomplete ul li": { padding: "2px 10px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--muted)", marginLeft: "10px" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 6px", padding: "6px 10px" },
  ".cm-search br": { display: "none" },
  ".cm-search label": { fontSize: "12px", color: "var(--text-soft)", display: "inline-flex", alignItems: "center", gap: "3px" },
  ".cm-textfield": {
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    padding: "3px 8px",
    fontSize: "12px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    padding: "3px 9px",
    fontSize: "12px",
  },
  ".cm-search [name=close]": { color: "var(--muted)", background: "none", border: "none", fontSize: "16px" },
  ".cm-searchMatch": { backgroundColor: "var(--warn-soft)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent)" },
  ".cm-selectionMatch": { backgroundColor: "var(--ok-soft)" },
  ".cm-current-stmt": { boxShadow: "inset 2px 0 0 var(--accent)" },
});

const PHRASES_ES: Record<string, string> = {
  Find: "Buscar",
  Replace: "Reemplazar",
  next: "siguiente",
  previous: "anterior",
  all: "todos",
  "match case": "mayúsculas",
  regexp: "regex",
  "by word": "palabra",
  replace: "reemplazar",
  "replace all": "reemplazar todo",
  close: "cerrar",
  "Go to line": "Ir a la línea",
  go: "ir",
  "current match": "coincidencia actual",
  "on line": "en la línea",
};

const phrasesFor = () => (getLang() === "es" ? PHRASES_ES : {});

const MAX_HIGHLIGHT_CHARS = 200_000;

const currentStatement = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const selection = state.selection.main;
      if (!selection.empty || state.doc.length > MAX_HIGHLIGHT_CHARS) return Decoration.none;
      const text = state.doc.toString();
      if (splitStatements(text).length < 2) return Decoration.none;
      const stmt = statementAt(text, selection.head);
      if (!stmt) return Decoration.none;
      const first = state.doc.lineAt(stmt.from).number;
      const last = state.doc.lineAt(stmt.to).number;
      const line = Decoration.line({ class: "cm-current-stmt" });
      const ranges = [];
      for (let n = first; n <= last; n++) ranges.push(line.range(state.doc.line(n).from));
      return Decoration.set(ranges);
    }
  },
  { decorations: (v) => v.decorations },
);

const wordBefore = (ctx: Parameters<CompletionSource>[0]) => {
  const word = ctx.matchBefore(/[A-Za-z_]\w*/);
  if (!word) return null;
  if (ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) === ".") return null;
  return word;
};

const snippetSource: CompletionSource = (ctx) => {
  const word = wordBefore(ctx);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: snippets(), validFor: /^\w*$/ };
};

function functionSource(functions: ObjectRef[]): CompletionSource {
  const options: Completion[] = functions.map((f) => ({
    label: f.name,
    detail: `(${f.detail ?? ""})`,
    type: "function",
    boost: -1,
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert: `${f.name}()` },
        selection: { anchor: from + f.name.length + 1 },
      });
    },
  }));
  return (ctx) => {
    const word = wordBefore(ctx);
    if (!word || (word.to - word.from < 2 && !ctx.explicit)) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

function joinSource(fks: ForeignKey[]): CompletionSource {
  return (ctx) => {
    const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);
    const match = /\bjoin\s+(\w*)$/i.exec(before);
    if (!match || (match[1] === "" && !ctx.explicit)) return null;
    const doc = ctx.state.doc.toString();
    const statement = statementAt(doc, ctx.pos)?.text ?? doc;
    const suggestions = joinSuggestions(statement, fks);
    if (suggestions.length === 0) return null;
    return {
      from: ctx.pos - match[1].length,
      options: suggestions.map((s) => ({
        label: s.label,
        detail: s.detail,
        type: "class",
        boost: 99,
        info: s.insert,
        apply: s.insert,
      })),
      validFor: /^\w*$/,
    };
  };
}

const sources = (...list: CompletionSource[]): Extension[] =>
  list.map((autocomplete) => EditorState.languageData.of(() => [{ autocomplete }]));

const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialValue, onRun, onFormat, onSave, readOnly = false, fill = false },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const extras = useRef(new Compartment());
  const phrases = useRef(new Compartment());
  const lang = useLang();
  const runRef = useRef(onRun);
  const formatRef = useRef(onFormat);
  const saveRef = useRef(onSave);
  runRef.current = onRun;
  formatRef.current = onFormat;
  saveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  runRef.current(false);
                  return true;
                },
              },
              {
                key: "Shift-Mod-Enter",
                run: () => {
                  runRef.current(true);
                  return true;
                },
              },
              {
                key: "Shift-Alt-f",
                run: () => {
                  formatRef.current();
                  return true;
                },
              },
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  saveRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          phrases.current.of(EditorState.phrases.of(phrasesFor())),
          EditorState.readOnly.of(readOnly),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          highlightSelectionMatches(),
          autocompletion({ activateOnTyping: true }),
          language.current.of(sql({ dialect: PostgreSQL, defaultSchema: "public" })),
          extras.current.of(sources(snippetSource)),
          readOnly ? [] : currentStatement,
          syntaxHighlighting(highlight),
          theme,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // Si cambia el idioma, el panel de buscar y reemplazar cambia sin recrear el editor ni perder el texto.
  useEffect(() => {
    view.current?.dispatch({ effects: phrases.current.reconfigure(EditorState.phrases.of(phrasesFor())) });
  }, [lang]);

  useImperativeHandle(ref, () => ({
    getRunnable: () => {
      const v = view.current;
      if (!v) return "";
      const { from, to } = v.state.selection.main;
      return from === to ? v.state.doc.toString() : v.state.sliceDoc(from, to);
    },
    getStatement: () => {
      const v = view.current;
      if (!v) return "";
      const { from, to, head } = v.state.selection.main;
      if (from !== to) return v.state.sliceDoc(from, to);
      return statementAt(v.state.doc.toString(), head)?.text ?? "";
    },
    getAll: () => view.current?.state.doc.toString() ?? "",
    setText: (text) => {
      const v = view.current;
      if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    transform: (fn) => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      if (from === to) {
        const next = fn(v.state.doc.toString());
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: next } });
      } else {
        const next = fn(v.state.sliceDoc(from, to));
        v.dispatch({ changes: { from, to, insert: next } });
      }
    },
    setSchema: (schema) => {
      view.current?.dispatch({
        effects: language.current.reconfigure(sql({ dialect: PostgreSQL, schema, defaultSchema: "public" })),
      });
    },
    setExtras: ({ functions, fks }) => {
      view.current?.dispatch({
        effects: extras.current.reconfigure(sources(snippetSource, functionSource(functions), joinSource(fks))),
      });
    },
    focus: () => view.current?.focus(),
  }));

  return <div className={"editor-host" + (fill ? " fill" : "")} ref={host} />;
});

export default SqlEditor;
