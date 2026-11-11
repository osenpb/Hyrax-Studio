import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export interface SqlEditorHandle {
  getRunnable: () => string;
  getAll: () => string;
  setText: (text: string) => void;
  transform: (fn: (text: string) => string) => void;
  setSchema: (schema: Record<string, string[]>) => void;
  focus: () => void;
}

interface Props {
  initialValue: string;
  onRun: () => void;
  onFormat: () => void;
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
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
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
});

const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor({ initialValue, onRun, onFormat }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const runRef = useRef(onRun);
  const formatRef = useRef(onFormat);
  runRef.current = onRun;
  formatRef.current = onFormat;

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
                  runRef.current();
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
            ]),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          language.current.of(sql({ dialect: PostgreSQL, defaultSchema: "public" })),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    getRunnable: () => {
      const v = view.current;
      if (!v) return "";
      const { from, to } = v.state.selection.main;
      return from === to ? v.state.doc.toString() : v.state.sliceDoc(from, to);
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
    focus: () => view.current?.focus(),
  }));

  return <div className="editor-host" ref={host} />;
});

export default SqlEditor;
