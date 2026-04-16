/**
 * cm-editor.js — CodeMirror 6 编辑器封装
 * 
 * 使用 esm.sh CDN 加载所有 CM6 模块。
 * 关键：所有包都通过 ?alias 参数指向同一份 @codemirror/state 和 @codemirror/view，
 * 避免"多个 @codemirror/state 实例"导致的 instanceof 检查失败。
 * 
 * 通过 <script type="module"> 动态导入，避免阻塞页面加载。
 */

// ── 统一版本号 ──
const V_STATE = '6.5.2';
const V_VIEW = '6.36.8';
const V_LANG = '6.11.0';
const V_CMD = '6.8.0';
const V_SEARCH = '6.5.10';
const V_AUTO = '6.18.6';

const CORE_ALIASES = {
  '@codemirror/state': `@codemirror/state@${V_STATE}`,
  '@codemirror/view': `@codemirror/view@${V_VIEW}`,
  '@codemirror/language': `@codemirror/language@${V_LANG}`,
  '@codemirror/commands': `@codemirror/commands@${V_CMD}`,
  '@codemirror/autocomplete': `@codemirror/autocomplete@${V_AUTO}`,
};

function _aliasQuery(aliases) {
  const pairs = Object.entries(aliases || {}).filter(([, target]) => !!target);
  if (!pairs.length) return '';
  return `?alias=${pairs.map(([name, target]) => `${name}:${target}`).join(',')}`;
}

function _esmUrl(pkgSpec, aliases) {
  return `https://esm.sh/${pkgSpec}${_aliasQuery(aliases)}`;
}

async function _optionalImport(label, pkgSpec, aliases) {
  try {
    return await import(_esmUrl(pkgSpec, aliases));
  } catch (err) {
    console.warn(`[CM] Optional module failed: ${label}`, err);
    return null;
  }
}

// ── 动态导入核心模块（必须成功） ──
const [stateMod, viewMod, langMod, cmdMod, searchMod, autoMod] = await Promise.all([
  import(_esmUrl(`@codemirror/state@${V_STATE}`)),
  import(_esmUrl(`@codemirror/view@${V_VIEW}`, {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
  })),
  import(_esmUrl(`@codemirror/language@${V_LANG}`, {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
  })),
  import(_esmUrl(`@codemirror/commands@${V_CMD}`, {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  })),
  import(_esmUrl(`@codemirror/search@${V_SEARCH}`, {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
  })),
  import(_esmUrl(`@codemirror/autocomplete@${V_AUTO}`, {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
    '@codemirror/commands': CORE_ALIASES['@codemirror/commands'],
  })),
]);

// ── 动态导入语言/主题模块（允许单个失败，不拖垮整体） ──
const [
  pyMod,
  jsMod,
  cssMod,
  htmlMod,
  jsonMod,
  mdMod,
  javaMod,
  cppMod,
  rustMod,
  goMod,
  phpMod,
  sqlMod,
  xmlMod,
  yamlMod,
  shellLegacyMod,
  powershellLegacyMod,
  dockerfileLegacyMod,
  vueMod,
  themeMod,
] = await Promise.all([
  _optionalImport('python', '@codemirror/lang-python@6.2.0', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('javascript', '@codemirror/lang-javascript@6.2.4', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('css', '@codemirror/lang-css@6.3.1', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('html', '@codemirror/lang-html@6.4.9', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
    '@codemirror/autocomplete': CORE_ALIASES['@codemirror/autocomplete'],
  }),
  _optionalImport('json', '@codemirror/lang-json@6.0.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('markdown', '@codemirror/lang-markdown@6.3.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('java', '@codemirror/lang-java@6.0.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('cpp', '@codemirror/lang-cpp@6.0.3', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('rust', '@codemirror/lang-rust@6.0.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('go', '@codemirror/lang-go@6.0.1', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('php', '@codemirror/lang-php@6.0.1', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('sql', '@codemirror/lang-sql@6.8.0', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('xml', '@codemirror/lang-xml@6.1.0', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('yaml', '@codemirror/lang-yaml@6.1.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
  }),
  _optionalImport('shell', '@codemirror/legacy-modes@6.4.3/mode/shell', {}),
  _optionalImport('powershell', '@codemirror/legacy-modes@6.4.3/mode/powershell', {}),
  _optionalImport('dockerfile', '@codemirror/legacy-modes@6.4.3/mode/dockerfile', {}),
  _optionalImport('vue', '@codemirror/lang-vue@0.1.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
    '@codemirror/language': CORE_ALIASES['@codemirror/language'],
    '@codemirror/lang-html': '@codemirror/lang-html@6.4.9',
    '@codemirror/lang-javascript': '@codemirror/lang-javascript@6.2.4',
  }),
  _optionalImport('theme-one-dark', '@codemirror/theme-one-dark@6.1.2', {
    '@codemirror/state': CORE_ALIASES['@codemirror/state'],
    '@codemirror/view': CORE_ALIASES['@codemirror/view'],
  }),
]);

// ── 解构导入 ──
const { EditorState, Compartment } = stateMod;
const { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
        highlightSpecialChars, drawSelection, highlightActiveLine,
        rectangularSelection, crosshairCursor } = viewMod;
const { defaultHighlightStyle, syntaxHighlighting, indentOnInput,
        bracketMatching, foldGutter, foldKeymap, StreamLanguage } = langMod;
const { defaultKeymap, history, historyKeymap, indentWithTab } = cmdMod;
const { searchKeymap, highlightSelectionMatches } = searchMod;
const { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } = autoMod;
const oneDark = themeMod?.oneDark || null;


// ══════════════════════════════════════════════════
//  暗色主题 — 匹配 Hermes WebUI 风格
// ══════════════════════════════════════════════════
const _hermesTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    lineHeight: '1.65',
    fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", "Fira Code", monospace',
    backgroundColor: 'transparent',
    color: 'var(--text)',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--text)',
    padding: '0',
    tabSize: '4',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--text)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(124, 185, 255, 0.22) !important',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    opacity: '0.55',
    borderRight: '1px solid var(--border)',
    fontSize: '11px',
    minWidth: '36px',
    paddingRight: '8px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    opacity: '0.8',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    color: 'var(--text) !important',
    outline: '1px solid rgba(124, 185, 255, 0.4)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(255, 200, 50, 0.15)',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '&.cm-readonly .cm-cursor': {
    display: 'none !important',
  },
  '&.cm-readonly .cm-selectionBackground': {
    backgroundColor: 'rgba(124, 185, 255, 0.12) !important',
  },
  '.cm-scroller': {
    overflow: 'auto',
    scrollbarWidth: 'thin',
  },
}, { dark: true });

// ══════════════════════════════════════════════════
//  语言映射
// ══════════════════════════════════════════════════
const _LANG_MAP = {
  python:     () => pyMod?.python?.(),
  javascript: () => jsMod?.javascript?.(),
  typescript: () => jsMod?.javascript?.({ typescript: true }),
  jsx:        () => jsMod?.javascript?.({ jsx: true }),
  tsx:        () => jsMod?.javascript?.({ jsx: true, typescript: true }),
  css:        () => cssMod?.css?.(),
  scss:       () => cssMod?.css?.(),
  less:       () => cssMod?.css?.(),
  markup:     () => htmlMod?.html?.(),
  html:       () => htmlMod?.html?.(),
  xml:        () => xmlMod?.xml?.(),
  svg:        () => xmlMod?.xml?.(),
  json:       () => jsonMod?.json?.(),
  yaml:       () => yamlMod?.yaml?.(),
  markdown:   () => mdMod?.markdown?.(),
  java:       () => javaMod?.java?.(),
  c:          () => cppMod?.cpp?.(),
  cpp:        () => cppMod?.cpp?.(),
  csharp:     () => cppMod?.cpp?.(),
  go:         () => goMod?.go?.(),
  rust:       () => rustMod?.rust?.(),
  php:        () => phpMod?.php?.(),
  sql:        () => sqlMod?.sql?.(),
  vue:        () => vueMod?.vue?.(),
  bash:       () => shellLegacyMod?.shell ? StreamLanguage.define(shellLegacyMod.shell) : null,
  shell:      () => shellLegacyMod?.shell ? StreamLanguage.define(shellLegacyMod.shell) : null,
  powershell: () => powershellLegacyMod?.powerShell ? StreamLanguage.define(powershellLegacyMod.powerShell) : null,
  docker:     () => dockerfileLegacyMod?.dockerFile ? StreamLanguage.define(dockerfileLegacyMod.dockerFile) : null,
  toml:       null,
  ini:        null,
  diff:       null,
  none:       null,
};

function _cmLangExtensions(prismLang) {
  if (!prismLang || prismLang === 'none') return [];
  const factory = _LANG_MAP[prismLang];
  const ext = factory ? factory() : null;
  return ext ? [ext] : [];
}

// ══════════════════════════════════════════════════
//  Compartment
// ══════════════════════════════════════════════════
const _langCompartment = new Compartment();
const _readonlyCompartment = new Compartment();

// ══════════════════════════════════════════════════
//  公开 API
// ══════════════════════════════════════════════════

let _cmView = null;

function createCmEditor(container, content, prismLang, editable) {
  destroyCmEditor();
  const langExts = _cmLangExtensions(prismLang);

  const state = EditorState.create({
    doc: content || '',
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
      history(), foldGutter(), drawSelection(), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(), closeBrackets(), autocompletion(),
      rectangularSelection(), crosshairCursor(), highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
        ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      _langCompartment.of(langExts),
      _readonlyCompartment.of(editable ? [] : [EditorState.readOnly.of(true)]),
      _hermesTheme,
      ...(oneDark ? [oneDark] : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && typeof _cmOnChange === 'function') {
          _cmOnChange(update.state.doc.toString());
        }
      }),
      EditorState.tabSize.of(4),
    ],
  });

  _cmView = new EditorView({ state, parent: container });
  if (!editable) _cmView.dom.classList.add('cm-readonly');
  return _cmView;
}

function destroyCmEditor() {
  if (_cmView) { _cmView.destroy(); _cmView = null; }
}

function getCmView() { return _cmView; }
function getCmContent() { return _cmView ? _cmView.state.doc.toString() : ''; }

function setCmEditable(editable) {
  if (!_cmView) return;
  _cmView.dispatch({
    effects: _readonlyCompartment.reconfigure(editable ? [] : [EditorState.readOnly.of(true)]),
  });
  if (editable) {
    _cmView.dom.classList.remove('cm-readonly');
    _cmView.focus();
  } else {
    _cmView.dom.classList.add('cm-readonly');
  }
}

function setCmLanguage(prismLang) {
  if (!_cmView) return;
  _cmView.dispatch({ effects: _langCompartment.reconfigure(_cmLangExtensions(prismLang)) });
}

function setCmContent(content) {
  if (!_cmView) return;
  _cmView.dispatch({ changes: { from: 0, to: _cmView.state.doc.length, insert: content || '' } });
}

let _cmOnChange = null;
function setCmOnChange(fn) { _cmOnChange = fn; }

window.CM_EDITOR = {
  create: createCmEditor,
  destroy: destroyCmEditor,
  getView: getCmView,
  getContent: getCmContent,
  setEditable: setCmEditable,
  setLanguage: setCmLanguage,
  setContent: setCmContent,
  onChange: setCmOnChange,
};
