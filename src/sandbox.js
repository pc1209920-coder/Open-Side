const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

const DEFAULT_MAX_EXECUTION_MS = 1500;
const DEFAULT_MAX_MEMORY_MB = 64;
const DEFAULT_MAX_CPU_LOAD_THRESHOLD = 0.85;
const DEFAULT_MAX_CODE_LENGTH = 65536;
const DEFAULT_VIRTUAL_TIMESTAMP = 1700000000000;
const MAX_SERIALIZATION_DEPTH = 128;
const MAX_OUTPUT_ARRAY_LENGTH = 5000000;
const MAX_RECONSTRUCT_NODES = 5000000;

const INVISIBLE_CHAR_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u00AD\u180E]/g;
const INVISIBLE_CHAR_TEST_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u00AD\u180E]/;

const FORBIDDEN_IDENTIFIERS = new Set([
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'global',
  'globalThis',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'AsyncGeneratorFunction',
  'WebAssembly',
  'Buffer',
  'Proxy',
  'Reflect',
  'import',
  'export',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  '__proto__',
  'constructor',
  'prototype',
  'setPrototypeOf',
  'defineProperty',
  'defineProperties',
  'prepareStackTrace',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__'
]);

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'in',
  'instanceof',
  'new',
  'yield',
  'await',
  'else',
  'do'
]);

const MULTI_CHAR_PUNCTUATORS = [
  '>>>=',
  '===',
  '!==',
  '>>>',
  '**=',
  '<<=',
  '>>=',
  '&&=',
  '||=',
  '??=',
  '...',
  '=>',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '??',
  '?.',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**'
];

const SINGLE_ASSIGN_OP_EXCLUDED = new Set(['.', '?.', '*', '/', '%', '**']);
const NON_CONST_SENTINEL = Symbol('NON_CONST');

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) {
        return true;
      }
      i += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function isLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isWhitespace(ch) {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\v' ||
    ch === '\f' ||
    ch === '\u00A0' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\u2028' ||
    ch === '\u2029' ||
    /\s/.test(ch)
  );
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexDigit(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isOctalDigit(ch) {
  return ch >= '0' && ch <= '7';
}

function isIdentStart(ch) {
  if (!ch) return false;
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    ch === '$' ||
    ch.charCodeAt(0) >= 0x80
  );
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

function decodeEscapeSequence(str, backslashIdx, options = {}) {
  const { allowOctal = true, decodeSimple = false } = options;
  if (backslashIdx + 1 >= str.length) {
    throw new SyntaxError('Malformed trailing escape sequence');
  }
  const next = str[backslashIdx + 1];

  if (next === 'u') {
    if (str[backslashIdx + 2] === '{') {
      const closeIdx = str.indexOf('}', backslashIdx + 3);
      if (closeIdx === -1) {
        throw new SyntaxError('Malformed Unicode code point escape sequence');
      }
      const hex = str.slice(backslashIdx + 3, closeIdx);
      if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new SyntaxError('Malformed Unicode code point escape sequence');
      }
      const cp = parseInt(hex, 16);
      if (!Number.isSafeInteger(cp) || cp < 0 || cp > 0x10FFFF) {
        throw new SyntaxError('Unicode code point escape out of range');
      }
      return { decoded: String.fromCodePoint(cp), nextIdx: closeIdx + 1, isLineContinuation: false };
    }

    const hex = str.slice(backslashIdx + 2, backslashIdx + 6);
    if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new SyntaxError('Malformed Unicode escape sequence');
    }
    return { decoded: String.fromCharCode(parseInt(hex, 16)), nextIdx: backslashIdx + 6, isLineContinuation: false };
  }

  if (next === 'x') {
    const hex = str.slice(backslashIdx + 2, backslashIdx + 4);
    if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) {
      throw new SyntaxError('Malformed hexadecimal escape sequence');
    }
    return { decoded: String.fromCharCode(parseInt(hex, 16)), nextIdx: backslashIdx + 4, isLineContinuation: false };
  }

  if (allowOctal && isOctalDigit(next)) {
    let end = backslashIdx + 2;
    if (next <= '3') {
      if (end < str.length && isOctalDigit(str[end])) end += 1;
      if (end < str.length && isOctalDigit(str[end])) end += 1;
    } else if (end < str.length && isOctalDigit(str[end])) {
      end += 1;
    }
    const oct = str.slice(backslashIdx + 1, end);
    return { decoded: String.fromCharCode(parseInt(oct, 8)), nextIdx: end, isLineContinuation: false };
  }

  if (next === '\r') {
    const extra = str[backslashIdx + 2] === '\n' ? 1 : 0;
    return { decoded: '', nextIdx: backslashIdx + 2 + extra, isLineContinuation: true };
  }
  if (next === '\n' || next === '\u2028' || next === '\u2029') {
    return { decoded: '', nextIdx: backslashIdx + 2, isLineContinuation: true };
  }

  if (decodeSimple) {
    const simpleMap = {
      '\\': '\\',
      "'": "'",
      '"': '"',
      '`': '`',
      '$': '$',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v'
    };
    const mapped = Object.prototype.hasOwnProperty.call(simpleMap, next) ? simpleMap[next] : next;
    return { decoded: mapped, nextIdx: backslashIdx + 2, isLineContinuation: false };
  }

  return { decoded: str.slice(backslashIdx, backslashIdx + 2), nextIdx: backslashIdx + 2, isLineContinuation: false };
}

function isStmtStartBefore(tokens, idx, braceStack) {
  if (idx < 0) return true;
  const tok = tokens[idx];
  if (tok.type === 'Punctuator') {
    if (tok.value === ';') return true;
    if (tok.value === '{') {
      const top = braceStack[braceStack.length - 1];
      return top === 'stmt-brace' || top === 'template';
    }
    if (tok.value === '}') {
      return tok.braceKind !== 'expr-brace';
    }
    if (tok.value === ':') {
      return !isTernaryOrObjectColon(tokens, idx);
    }
    return false;
  }
  if (tok.type === 'Identifier') {
    return tok.value === 'else' || tok.value === 'do' || tok.value === 'export' || tok.value === 'default';
  }
  return false;
}

function isTernaryOrObjectColon(tokens, colonIdx) {
  let p = 0;
  let b = 0;
  let c = 0;
  let ternaryDepth = 0;
  for (let i = colonIdx - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'Punctuator') {
      if (t.value === ')') p += 1;
      else if (t.value === '(') {
        if (p === 0) return true; // inside `(...)`: ternary colon
        p -= 1;
      } else if (t.value === ']') b += 1;
      else if (t.value === '[') {
        if (b === 0) return true;
        b -= 1;
      } else if (t.value === '}') c += 1;
      else if (t.value === '{') {
        if (c === 0) {
          return t.braceKind === 'expr-brace';
        }
        c -= 1;
      } else if (p === 0 && b === 0 && c === 0) {
        if (t.value === '?') {
          if (ternaryDepth === 0) return true;
          ternaryDepth -= 1;
        } else if (t.value === ':') {
          ternaryDepth += 1;
        } else if (t.value === ';') {
          return false;
        }
      }
    } else if (p === 0 && b === 0 && c === 0 && t.type === 'Identifier') {
      if (t.value === 'case' || t.value === 'default') return false;
    }
  }
  return false;
}

function classifyTrailingClassOpenBrace(tokens, braceStack) {
  const n = tokens.length;
  let k = n - 1;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  while (k >= 0) {
    const tk = tokens[k];
    if (tk.type === 'Punctuator') {
      if (tk.value === ')') pd += 1;
      else if (tk.value === '(') {
        if (pd === 0) break;
        pd -= 1;
      } else if (tk.value === ']') bd += 1;
      else if (tk.value === '[') {
        if (bd === 0) break;
        bd -= 1;
      } else if (tk.value === '}') cd += 1;
      else if (tk.value === '{') {
        if (cd === 0) break;
        cd -= 1;
      } else if (
        pd === 0 &&
        bd === 0 &&
        cd === 0 &&
        (tk.value === ';' || tk.value === ',' || tk.value === '=' || tk.value === ':' || tk.value === '?' || tk.value === '=>')
      ) {
        break;
      }
    } else if (pd === 0 && bd === 0 && cd === 0 && tk.type === 'Identifier') {
      if (tk.value === 'class') {
        const nextTok = tokens[k + 1];
        if (nextTok && nextTok.type === 'Punctuator' && nextTok.value === '(') {
          break;
        }
        return isStmtStartBefore(tokens, k - 1, braceStack) ? 'stmt-brace' : 'expr-brace';
      }
      if (
        tk.value === 'return' ||
        tk.value === 'throw' ||
        tk.value === 'yield' ||
        tk.value === 'await' ||
        tk.value === 'typeof' ||
        tk.value === 'void' ||
        tk.value === 'delete' ||
        tk.value === 'in' ||
        tk.value === 'instanceof' ||
        tk.value === 'new' ||
        tk.value === 'of'
      ) {
        break;
      }
    }
    k -= 1;
  }
  return null;
}

function classifyOpenBrace(tokens, braceStack) {
  const n = tokens.length;
  if (n === 0) return 'stmt-brace';
  const prev = tokens[n - 1];

  if (prev.type === 'Identifier') {
    if (prev.value === 'else' || prev.value === 'do' || prev.value === 'try' || prev.value === 'finally' || prev.value === 'static' || prev.value === 'catch') {
      return 'stmt-brace';
    }
    if (prev.value === 'return' || prev.value === 'throw' || prev.value === 'yield' || prev.value === 'await' ||
        prev.value === 'typeof' || prev.value === 'void' || prev.value === 'delete' || prev.value === 'in' ||
        prev.value === 'instanceof' || prev.value === 'new' || prev.value === 'of' || prev.value === 'case') {
      return 'expr-brace';
    }
    if (prev.value === 'class') {
      let beforeClass = n - 2;
      if (beforeClass >= 0 && tokens[beforeClass].type === 'Identifier' && tokens[beforeClass].value === 'default') {
        beforeClass -= 1;
      }
      return isStmtStartBefore(tokens, beforeClass, braceStack) ? 'stmt-brace' : 'expr-brace';
    }
    // Named `class Foo { ... }` or `class Foo extends Bar { ... }`
    const classKind = classifyTrailingClassOpenBrace(tokens, braceStack);
    if (classKind !== null) {
      return classKind;
    }
    return 'stmt-brace';
  }

  if (prev.type === 'Punctuator') {
    if (prev.value === ';') return 'stmt-brace';
    if (prev.value === '=>') return 'stmt-brace';
    if (prev.value === '{') {
      const top = braceStack[braceStack.length - 1];
      return top === 'expr-brace' ? 'expr-brace' : 'stmt-brace';
    }
    if (prev.value === '}') {
      return prev.braceKind === 'expr-brace' ? 'expr-brace' : 'stmt-brace';
    }
    if (prev.value === ':') {
      return isTernaryOrObjectColon(tokens, n - 1) ? 'expr-brace' : 'stmt-brace';
    }
    if (prev.value === ')') {
      let depth = 0;
      let openIdx = -1;
      for (let k = n - 1; k >= 0; k--) {
        const tk = tokens[k];
        if (tk.type === 'Punctuator') {
          if (tk.value === ')') depth += 1;
          else if (tk.value === '(') {
            depth -= 1;
            if (depth === 0) {
              openIdx = k;
              break;
            }
          }
        }
      }
      if (openIdx <= 0) return 'stmt-brace';
      const before = tokens[openIdx - 1];
      if (before && before.type === 'Identifier') {
        if (before.value === 'if' || before.value === 'while' || before.value === 'for' ||
            before.value === 'with' || before.value === 'switch' || before.value === 'catch') {
          return 'stmt-brace';
        }
        if (before.value === 'await' && tokens[openIdx - 2] && tokens[openIdx - 2].type === 'Identifier' && tokens[openIdx - 2].value === 'for') {
          return 'stmt-brace';
        }
        // `function(...) {}` or `function name(...) {}`
        let fnIdx = -1;
        if (before.value === 'function') {
          fnIdx = openIdx - 1;
        } else if (tokens[openIdx - 2] && tokens[openIdx - 2].type === 'Identifier' && tokens[openIdx - 2].value === 'function') {
          fnIdx = openIdx - 2;
        } else if (tokens[openIdx - 2] && tokens[openIdx - 2].type === 'Punctuator' && tokens[openIdx - 2].value === '*') {
          if (tokens[openIdx - 3] && tokens[openIdx - 3].type === 'Identifier' && tokens[openIdx - 3].value === 'function') {
            fnIdx = openIdx - 3;
          }
        } else if (tokens[openIdx - 3] && tokens[openIdx - 3].type === 'Punctuator' && tokens[openIdx - 3].value === '*' &&
                   tokens[openIdx - 4] && tokens[openIdx - 4].type === 'Identifier' && tokens[openIdx - 4].value === 'function') {
          fnIdx = openIdx - 4;
        }
        if (fnIdx !== -1) {
          let declCheckIdx = fnIdx - 1;
          if (declCheckIdx >= 0 && tokens[declCheckIdx].type === 'Identifier' && tokens[declCheckIdx].value === 'async') {
            declCheckIdx -= 1;
          }
          return isStmtStartBefore(tokens, declCheckIdx, braceStack) ? 'stmt-brace' : 'expr-brace';
        }
      } else if (before && before.type === 'Punctuator' && before.value === '*') {
        let fnIdx = -1;
        if (tokens[openIdx - 2] && tokens[openIdx - 2].type === 'Identifier' && tokens[openIdx - 2].value === 'function') {
          fnIdx = openIdx - 2;
        }
        if (fnIdx !== -1) {
          let declCheckIdx = fnIdx - 1;
          if (declCheckIdx >= 0 && tokens[declCheckIdx].type === 'Identifier' && tokens[declCheckIdx].value === 'async') {
            declCheckIdx -= 1;
          }
          return isStmtStartBefore(tokens, declCheckIdx, braceStack) ? 'stmt-brace' : 'expr-brace';
        }
      }
      const classKind = classifyTrailingClassOpenBrace(tokens, braceStack);
      if (classKind !== null) {
        return classKind;
      }
      return 'stmt-brace';
    }
    return 'expr-brace';
  }

  return 'stmt-brace';
}

function isInsideForHeader(tokens) {
  let pd = 0;
  let bd = 0;
  let cd = 0;
  for (let k = tokens.length - 2; k >= 0; k--) {
    const tk = tokens[k];
    if (tk.type === 'Punctuator') {
      if (tk.value === ')') pd += 1;
      else if (tk.value === '(') {
        if (pd === 0) {
          const prev = tokens[k - 1];
          if (prev && prev.type === 'Identifier') {
            if (prev.value === 'for') return true;
            if (prev.value === 'await' && tokens[k - 2] && tokens[k - 2].type === 'Identifier' && tokens[k - 2].value === 'for') {
              return true;
            }
          }
          return false;
        }
        pd -= 1;
      } else if (tk.value === ']') bd += 1;
      else if (tk.value === '[') {
        if (bd === 0) return false;
        bd -= 1;
      } else if (tk.value === '}') cd += 1;
      else if (tk.value === '{') {
        if (cd === 0) return false;
        cd -= 1;
      } else if (pd === 0 && bd === 0 && cd === 0 && tk.value === ';') {
        return false;
      }
    }
  }
  return false;
}

function canStartRegex(tokens, lineTermSinceLastToken = false) {
  if (!tokens || tokens.length === 0) return true;
  const lastToken = tokens[tokens.length - 1];
  if (!lastToken) return true;
  if (lastToken.type === 'Identifier') {
    if (REGEX_PREFIX_KEYWORDS.has(lastToken.value)) {
      return true;
    }
    if (lastToken.value === 'of') {
      return isInsideForHeader(tokens);
    }
    if (
      lineTermSinceLastToken &&
      (lastToken.value === 'break' || lastToken.value === 'continue' || lastToken.value === 'debugger')
    ) {
      return true;
    }
    return false;
  }
  if (lastToken.type === 'Punctuator') {
    if (lastToken.value === '}') {
      return lastToken.braceKind !== 'expr-brace';
    }
    if (lastToken.value === ')') {
      let depth = 0;
      let openIdx = -1;
      for (let k = tokens.length - 1; k >= 0; k--) {
        const tk = tokens[k];
        if (tk.type === 'Punctuator') {
          if (tk.value === ')') depth += 1;
          else if (tk.value === '(') {
            depth -= 1;
            if (depth === 0) {
              openIdx = k;
              break;
            }
          }
        }
      }
      if (openIdx <= 0) return false;
      const before = tokens[openIdx - 1];
      if (before && before.type === 'Identifier') {
        if (before.value === 'if' || before.value === 'while' || before.value === 'for' || before.value === 'with') {
          return true;
        }
        if (before.value === 'await' && tokens[openIdx - 2] && tokens[openIdx - 2].type === 'Identifier' && tokens[openIdx - 2].value === 'for') {
          return true;
        }
      }
      return false;
    }
    return (
      lastToken.value !== ']' &&
      lastToken.value !== '++' &&
      lastToken.value !== '--'
    );
  }
  return false;
}

function readNumberEnd(code, start) {
  const len = code.length;
  let i = start;

  if (code[i] === '0' && i + 1 < len && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
    i += 2;
    while (i < len && (isHexDigit(code[i]) || code[i] === '_')) {
      i += 1;
    }
    if (i < len && code[i] === 'n') {
      i += 1;
    }
    return i;
  }

  if (code[i] === '0' && i + 1 < len && (code[i + 1] === 'b' || code[i + 1] === 'B')) {
    i += 2;
    while (i < len && (code[i] === '0' || code[i] === '1' || code[i] === '_')) {
      i += 1;
    }
    if (i < len && code[i] === 'n') {
      i += 1;
    }
    return i;
  }

  if (code[i] === '0' && i + 1 < len && (code[i + 1] === 'o' || code[i + 1] === 'O')) {
    i += 2;
    while (i < len && (isOctalDigit(code[i]) || code[i] === '_')) {
      i += 1;
    }
    if (i < len && code[i] === 'n') {
      i += 1;
    }
    return i;
  }

  let hasDot = false;
  if (code[i] === '.') {
    hasDot = true;
    i += 1;
    while (i < len && (isDigit(code[i]) || code[i] === '_')) {
      i += 1;
    }
  } else {
    while (i < len && (isDigit(code[i]) || code[i] === '_')) {
      i += 1;
    }
    if (i < len && code[i] === '.') {
      hasDot = true;
      i += 1;
      while (i < len && (isDigit(code[i]) || code[i] === '_')) {
        i += 1;
      }
    }
  }

  if (!hasDot && i < len && code[i] === 'n') {
    return i + 1;
  }

  if (i < len && (code[i] === 'e' || code[i] === 'E')) {
    let expIdx = i + 1;
    if (expIdx < len && (code[expIdx] === '+' || code[expIdx] === '-')) {
      expIdx += 1;
    }
    if (expIdx < len && isDigit(code[expIdx])) {
      i = expIdx;
      while (i < len && (isDigit(code[i]) || code[i] === '_')) {
        i += 1;
      }
    }
  }

  return i;
}

/**
 * Normalizes JavaScript source code by decoding Unicode (\uXXXX, \u{...}),
 * hexadecimal (\xXX), and octal escape sequences outside comments/regex
 * backreferences, collapsing line continuations, and stripping invisible
 * zero-width characters.
 * @param {string} code
 * @returns {string}
 */
function normalizeTaskCode(code) {
  if (typeof code !== 'string') {
    throw new TypeError('Invalid code: must be a string');
  }

  let out = '';
  let i = 0;
  const len = code.length;
  const braceStack = [];
  const sigTokens = [];

  const recordSigToken = (tok) => {
    sigTokens.push(tok);
  };

  while (i < len) {
    const ch = code[i];

    // Comments: copy verbatim without interpreting escapes
    if (ch === '/' && code[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < len && !isLineTerminator(code[i])) i += 1;
      out += code.slice(start, i);
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const start = i;
      const endIdx = code.indexOf('*/', i + 2);
      if (endIdx === -1) {
        throw new SyntaxError('Unterminated block comment');
      }
      i = endIdx + 2;
      out += code.slice(start, i);
      continue;
    }

    // String literals
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < len && code[i] !== quote) {
        if (isLineTerminator(code[i])) {
          throw new SyntaxError('Unterminated string literal');
        }
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: false });
          out += esc.decoded;
          i = esc.nextIdx;
        } else {
          out += code[i];
          i += 1;
        }
      }
      if (i >= len) {
        throw new SyntaxError('Unterminated string literal');
      }
      out += quote;
      i += 1;
      recordSigToken({ type: 'String', value: '' });
      continue;
    }

    // Template literals
    if (ch === '`') {
      out += '`';
      i += 1;
      while (i < len && code[i] !== '`') {
        if (code[i] === '$' && code[i + 1] === '{') {
          out += '${';
          i += 2;
          braceStack.push('template');
          recordSigToken({ type: 'Punctuator', value: '${' });
          break;
        }
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: false });
          out += esc.decoded;
          i = esc.nextIdx;
        } else {
          out += code[i];
          i += 1;
        }
      }
      if (braceStack[braceStack.length - 1] !== 'template') {
        if (i >= len || code[i] !== '`') {
          throw new SyntaxError('Unterminated template literal');
        }
        out += '`';
        i += 1;
        recordSigToken({ type: 'TemplateNoSub', value: '' });
      }
      continue;
    }

    // Resume template body when closing '}' of ${...}
    if (ch === '}' && braceStack.length > 0 && braceStack[braceStack.length - 1] === 'template') {
      braceStack.pop();
      out += '}';
      i += 1;
      while (i < len && code[i] !== '`') {
        if (code[i] === '$' && code[i + 1] === '{') {
          out += '${';
          i += 2;
          braceStack.push('template');
          recordSigToken({ type: 'Punctuator', value: '${' });
          break;
        }
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: false });
          out += esc.decoded;
          i = esc.nextIdx;
        } else {
          out += code[i];
          i += 1;
        }
      }
      if (braceStack[braceStack.length - 1] !== 'template') {
        if (i >= len || code[i] !== '`') {
          throw new SyntaxError('Unterminated template literal');
        }
        out += '`';
        i += 1;
        recordSigToken({ type: 'TemplateTail', value: '' });
      }
      continue;
    }

    // Regex literal vs division
    if (ch === '/' && canStartRegex(sigTokens)) {
      out += '/';
      i += 1;
      let inCharClass = false;
      let closedRegex = false;
      while (i < len) {
        const rc = code[i];
        if (isLineTerminator(rc)) {
          throw new SyntaxError('Unterminated regular expression literal');
        }
        if (rc === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: false, decodeSimple: false });
          out += esc.decoded;
          i = esc.nextIdx;
          continue;
        }
        if (rc === '[') {
          inCharClass = true;
        } else if (rc === ']' && inCharClass) {
          inCharClass = false;
        } else if (rc === '/' && !inCharClass) {
          out += '/';
          i += 1;
          closedRegex = true;
          break;
        }
        out += rc;
        i += 1;
      }
      if (!closedRegex) {
        throw new SyntaxError('Unterminated regular expression literal');
      }
      while (i < len && isIdentPart(code[i])) {
        out += code[i];
        i += 1;
      }
      recordSigToken({ type: 'RegExp', value: '' });
      continue;
    }

    if (ch === '{') {
      const braceKind = classifyOpenBrace(sigTokens, braceStack);
      braceStack.push(braceKind);
      out += ch;
      i += 1;
      recordSigToken({ type: 'Punctuator', value: '{', braceKind });
      continue;
    }
    if (ch === '}') {
      let braceKind = 'stmt-brace';
      if (braceStack.length > 0 && braceStack[braceStack.length - 1] !== 'template') {
        braceKind = braceStack.pop();
      }
      out += ch;
      i += 1;
      recordSigToken({ type: 'Punctuator', value: '}', braceKind });
      continue;
    }

    if (INVISIBLE_CHAR_REGEX.test(ch)) {
      INVISIBLE_CHAR_REGEX.lastIndex = 0;
      i += 1;
      continue;
    }

    if (isWhitespace(ch)) {
      out += ch;
      i += 1;
      continue;
    }

    // Identifiers (including leading escape like \u0070rocess or \x72equire)
    if (isIdentStart(ch) || ch === '\\') {
      let ident = '';
      while (i < len) {
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: false });
          ident += esc.decoded;
          i = esc.nextIdx;
        } else if (isIdentPart(code[i])) {
          ident += code[i];
          i += 1;
        } else if (INVISIBLE_CHAR_REGEX.test(code[i])) {
          INVISIBLE_CHAR_REGEX.lastIndex = 0;
          i += 1;
        } else {
          break;
        }
      }
      INVISIBLE_CHAR_REGEX.lastIndex = 0;
      out += ident;
      recordSigToken({ type: 'Identifier', value: ident });
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(code[i + 1]))) {
      const start = i;
      while (i < len) {
        if ((code[i] === 'e' || code[i] === 'E') && (code[i + 1] === '+' || code[i + 1] === '-')) {
          i += 2;
        } else if (isIdentPart(code[i]) || code[i] === '.') {
          i += 1;
        } else {
          break;
        }
      }
      out += code.slice(start, i);
      recordSigToken({ type: 'Number', value: code.slice(start, i) });
      continue;
    }

    // Multi-char punctuators
    let matchedPunct = null;
    for (const p of MULTI_CHAR_PUNCTUATORS) {
      if (code.startsWith(p, i)) {
        matchedPunct = p;
        break;
      }
    }
    if (matchedPunct) {
      out += matchedPunct;
      i += matchedPunct.length;
      recordSigToken({ type: 'Punctuator', value: matchedPunct });
      continue;
    }

    out += ch;
    i += 1;
    recordSigToken({ type: 'Punctuator', value: ch });
  }

  if (braceStack.includes('template')) {
    throw new SyntaxError('Unterminated template literal');
  }

  return out.replace(INVISIBLE_CHAR_REGEX, '');
}

function tokenizeTaskCode(code) {
  const tokens = [];
  let i = 0;
  const len = code.length;
  const braceStack = [];

  const pushToken = (tok) => {
    tokens.push(tok);
  };

  const scanTemplateChunk = (isStart) => {
    let val = '';
    while (i < len && code[i] !== '`') {
      if (code[i] === '$' && code[i + 1] === '{') {
        i += 2;
        braceStack.push('template');
        pushToken({
          type: isStart ? 'TemplateHead' : 'TemplateMid',
          value: val.replace(INVISIBLE_CHAR_REGEX, '')
        });
        return;
      }
      if (code[i] === '\\') {
        const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: true });
        val += esc.decoded;
        i = esc.nextIdx;
      } else {
        val += code[i];
        i += 1;
      }
    }
    if (i >= len) {
      throw new SyntaxError('Unterminated template literal');
    }
    i += 1; // consume closing `
    pushToken({
      type: isStart ? 'TemplateNoSub' : 'TemplateTail',
      value: val.replace(INVISIBLE_CHAR_REGEX, '')
    });
  };

  while (i < len) {
    const ch = code[i];

    if (isWhitespace(ch) || INVISIBLE_CHAR_REGEX.test(ch)) {
      INVISIBLE_CHAR_REGEX.lastIndex = 0;
      i += 1;
      continue;
    }

    // Comments
    if (ch === '/' && code[i + 1] === '/') {
      i += 2;
      while (i < len && !isLineTerminator(code[i])) i += 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const endIdx = code.indexOf('*/', i + 2);
      if (endIdx === -1) {
        throw new SyntaxError('Unterminated block comment');
      }
      i = endIdx + 2;
      continue;
    }

    // Strings
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let val = '';
      while (i < len && code[i] !== quote) {
        if (isLineTerminator(code[i])) {
          throw new SyntaxError('Unterminated string literal');
        }
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: true });
          val += esc.decoded;
          i = esc.nextIdx;
        } else {
          val += code[i];
          i += 1;
        }
      }
      if (i >= len) {
        throw new SyntaxError('Unterminated string literal');
      }
      i += 1;
      pushToken({ type: 'String', value: val.replace(INVISIBLE_CHAR_REGEX, '') });
      continue;
    }

    // Template literal start
    if (ch === '`') {
      i += 1;
      scanTemplateChunk(true);
      continue;
    }

    // Resume template chunk after ${ ... }
    if (ch === '}' && braceStack.length > 0 && braceStack[braceStack.length - 1] === 'template') {
      braceStack.pop();
      i += 1;
      scanTemplateChunk(false);
      continue;
    }

    // Regex literal vs division
    if (ch === '/' && canStartRegex(tokens)) {
      const start = i;
      i += 1;
      let inCharClass = false;
      let closedRegex = false;
      while (i < len) {
        const rc = code[i];
        if (isLineTerminator(rc)) {
          throw new SyntaxError('Unterminated regular expression literal');
        }
        if (rc === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: false, decodeSimple: false });
          i = esc.nextIdx;
          continue;
        }
        if (rc === '[') {
          inCharClass = true;
        } else if (rc === ']' && inCharClass) {
          inCharClass = false;
        } else if (rc === '/' && !inCharClass) {
          i += 1;
          closedRegex = true;
          break;
        }
        i += 1;
      }
      if (!closedRegex) {
        throw new SyntaxError('Unterminated regular expression literal');
      }
      while (i < len && isIdentPart(code[i])) i += 1;
      pushToken({ type: 'RegExp', value: code.slice(start, i) });
      continue;
    }

    if (ch === '{') {
      const braceKind = classifyOpenBrace(tokens, braceStack);
      braceStack.push(braceKind);
      i += 1;
      pushToken({ type: 'Punctuator', value: '{', braceKind });
      continue;
    }
    if (ch === '}') {
      if (braceStack.length === 0) {
        throw new SyntaxError('Unexpected closing brace "}" in task code');
      }
      const braceKind = braceStack.pop();
      i += 1;
      pushToken({ type: 'Punctuator', value: '}', braceKind });
      continue;
    }

    // Identifier or escape-encoded identifier
    if (isIdentStart(ch) || ch === '\\') {
      let name = '';
      while (i < len) {
        if (code[i] === '\\') {
          const esc = decodeEscapeSequence(code, i, { allowOctal: true, decodeSimple: false });
          name += esc.decoded;
          i = esc.nextIdx;
        } else if (isIdentPart(code[i])) {
          name += code[i];
          i += 1;
        } else if (INVISIBLE_CHAR_REGEX.test(code[i])) {
          INVISIBLE_CHAR_REGEX.lastIndex = 0;
          i += 1;
        } else {
          break;
        }
      }
      INVISIBLE_CHAR_REGEX.lastIndex = 0;
      const cleaned = name.replace(INVISIBLE_CHAR_REGEX, '');
      pushToken({ type: 'Identifier', value: cleaned });
      continue;
    }

    // Numeric literal (including hex/octal/binary/bigint/scientific)
    if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(code[i + 1]))) {
      const start = i;
      while (i < len) {
        if ((code[i] === 'e' || code[i] === 'E') && (code[i + 1] === '+' || code[i + 1] === '-')) {
          i += 2;
        } else if (isIdentPart(code[i]) || code[i] === '.') {
          i += 1;
        } else {
          break;
        }
      }
      pushToken({ type: 'Number', value: code.slice(start, i) });
      continue;
    }

    // Multi-character punctuators
    let matchedPunct = null;
    for (const p of MULTI_CHAR_PUNCTUATORS) {
      if (code.startsWith(p, i)) {
        matchedPunct = p;
        break;
      }
    }
    if (matchedPunct) {
      i += matchedPunct.length;
      pushToken({ type: 'Punctuator', value: matchedPunct });
      continue;
    }

    i += 1;
    pushToken({ type: 'Punctuator', value: ch });
  }

  if (braceStack.length > 0) {
    throw new SyntaxError('Unclosed block or template expression in task code');
  }

  return tokens;
}

function findForbiddenWordInString(str) {
  if (!str) return null;
  const cleaned = str.replace(INVISIBLE_CHAR_REGEX, '');
  const wordRegex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match;
  while ((match = wordRegex.exec(cleaned)) !== null) {
    if (FORBIDDEN_IDENTIFIERS.has(match[0])) {
      return match[0];
    }
  }
  return null;
}

function findMatchingClose(tokens, openIdx, openVal, closeVal) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'Punctuator') {
      if (t.value === openVal) depth += 1;
      else if (t.value === closeVal) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function tryEvalStringAtom(tokens, idx, constEnv) {
  if (idx >= tokens.length) return null;
  const t = tokens[idx];

  if (t.type === 'String' || t.type === 'TemplateNoSub') {
    let val = t.value;
    let nextIdx = idx + 1;
    // Check trailing .split('').reverse().join('')
    if (
      tokens[nextIdx] && tokens[nextIdx].type === 'Punctuator' && tokens[nextIdx].value === '.' &&
      tokens[nextIdx + 1] && tokens[nextIdx + 1].type === 'Identifier' && tokens[nextIdx + 1].value === 'split' &&
      tokens[nextIdx + 2] && tokens[nextIdx + 2].type === 'Punctuator' && tokens[nextIdx + 2].value === '(' &&
      tokens[nextIdx + 3] && tokens[nextIdx + 3].type === 'String' && tokens[nextIdx + 3].value === '' &&
      tokens[nextIdx + 4] && tokens[nextIdx + 4].type === 'Punctuator' && tokens[nextIdx + 4].value === ')' &&
      tokens[nextIdx + 5] && tokens[nextIdx + 5].type === 'Punctuator' && tokens[nextIdx + 5].value === '.' &&
      tokens[nextIdx + 6] && tokens[nextIdx + 6].type === 'Identifier' && tokens[nextIdx + 6].value === 'reverse' &&
      tokens[nextIdx + 7] && tokens[nextIdx + 7].type === 'Punctuator' && tokens[nextIdx + 7].value === '(' &&
      tokens[nextIdx + 8] && tokens[nextIdx + 8].type === 'Punctuator' && tokens[nextIdx + 8].value === ')' &&
      tokens[nextIdx + 9] && tokens[nextIdx + 9].type === 'Punctuator' && tokens[nextIdx + 9].value === '.' &&
      tokens[nextIdx + 10] && tokens[nextIdx + 10].type === 'Identifier' && tokens[nextIdx + 10].value === 'join' &&
      tokens[nextIdx + 11] && tokens[nextIdx + 11].type === 'Punctuator' && tokens[nextIdx + 11].value === '(' &&
      tokens[nextIdx + 12] && tokens[nextIdx + 12].type === 'String' &&
      tokens[nextIdx + 13] && tokens[nextIdx + 13].type === 'Punctuator' && tokens[nextIdx + 13].value === ')'
    ) {
      val = val.split('').reverse().join(tokens[nextIdx + 12].value);
      nextIdx += 14;
    }
    return { value: val, nextIdx, literalCount: 1 };
  }

  if (t.type === 'TemplateHead') {
    let combined = t.value;
    let cur = idx + 1;
    let litCount = 1;
    while (cur < tokens.length) {
      const inner = tryEvalStringExpr(tokens, cur, constEnv);
      if (!inner) return null;
      combined += inner.value;
      litCount += inner.literalCount;
      cur = inner.nextIdx;
      if (!tokens[cur]) return null;
      if (tokens[cur].type === 'TemplateMid') {
        combined += tokens[cur].value;
        cur += 1;
      } else if (tokens[cur].type === 'TemplateTail') {
        combined += tokens[cur].value;
        cur += 1;
        return { value: combined, nextIdx: cur, literalCount: litCount };
      } else {
        return null;
      }
    }
    return null;
  }

  if (t.type === 'Identifier') {
    // Check String.fromCharCode(n1, n2, ...) and String.fromCodePoint(n1, n2, ...)
    if (
      t.value === 'String' &&
      tokens[idx + 1] && tokens[idx + 1].type === 'Punctuator' && tokens[idx + 1].value === '.' &&
      tokens[idx + 2] && tokens[idx + 2].type === 'Identifier' &&
      (tokens[idx + 2].value === 'fromCharCode' || tokens[idx + 2].value === 'fromCodePoint') &&
      tokens[idx + 3] && tokens[idx + 3].type === 'Punctuator' && tokens[idx + 3].value === '('
    ) {
      const fnName = tokens[idx + 2].value;
      const closeIdx = findMatchingClose(tokens, idx + 3, '(', ')');
      if (closeIdx !== -1) {
        const codes = [];
        let ok = true;
        for (let j = idx + 4; j < closeIdx; j++) {
          const argTok = tokens[j];
          if (argTok.type === 'Number') {
            const num = Number(argTok.value);
            if (!Number.isFinite(num)) {
              ok = false;
              break;
            }
            codes.push(num);
          } else if (argTok.type === 'Punctuator' && argTok.value === ',') {
            continue;
          } else {
            ok = false;
            break;
          }
        }
        if (ok && codes.length > 0 && codes.length <= 256) {
          try {
            return { value: String[fnName](...codes), nextIdx: closeIdx + 1, literalCount: 2 };
          } catch {
            // RangeError on out-of-range codePoint -> treat as non-foldable
          }
        }
      }
    }

    if (constEnv && constEnv.has(t.value)) {
      const bound = constEnv.get(t.value);
      if (bound !== NON_CONST_SENTINEL && typeof bound === 'string') {
        return { value: bound, nextIdx: idx + 1, literalCount: 1 };
      }
    }
    return null;
  }

  if (t.type === 'Punctuator' && t.value === '(') {
    const closeIdx = findMatchingClose(tokens, idx, '(', ')');
    if (closeIdx === -1) return null;
    const inner = tryEvalStringExpr(tokens, idx + 1, constEnv);
    if (inner && inner.nextIdx === closeIdx) {
      return { value: inner.value, nextIdx: closeIdx + 1, literalCount: inner.literalCount };
    }
    return null;
  }

  // Constant array literal ['a', 'b'].join('')
  if (t.type === 'Punctuator' && t.value === '[') {
    const closeBracket = findMatchingClose(tokens, idx, '[', ']');
    if (closeBracket === -1) return null;
    if (
      tokens[closeBracket + 1] && tokens[closeBracket + 1].type === 'Punctuator' && tokens[closeBracket + 1].value === '.' &&
      tokens[closeBracket + 2] && tokens[closeBracket + 2].type === 'Identifier' && tokens[closeBracket + 2].value === 'join' &&
      tokens[closeBracket + 3] && tokens[closeBracket + 3].type === 'Punctuator' && tokens[closeBracket + 3].value === '('
    ) {
      const closeJoin = findMatchingClose(tokens, closeBracket + 3, '(', ')');
      if (closeJoin !== -1) {
        let sep = ',';
        if (closeJoin === closeBracket + 5 && (tokens[closeBracket + 4].type === 'String' || tokens[closeBracket + 4].type === 'TemplateNoSub')) {
          sep = tokens[closeBracket + 4].value;
        } else if (closeJoin !== closeBracket + 4) {
          return null;
        }
        const parts = [];
        let k = idx + 1;
        while (k < closeBracket) {
          const item = tryEvalStringExpr(tokens, k, constEnv);
          if (!item) return null;
          parts.push(item.value);
          k = item.nextIdx;
          if (k < closeBracket) {
            if (tokens[k].type === 'Punctuator' && tokens[k].value === ',') {
              k += 1;
            } else {
              return null;
            }
          }
        }
        return { value: parts.join(sep), nextIdx: closeJoin + 1, literalCount: Math.max(2, parts.length) };
      }
    }
  }

  return null;
}

function tryEvalStringExpr(tokens, startIdx, constEnv) {
  const first = tryEvalStringAtom(tokens, startIdx, constEnv);
  if (!first) return null;
  let result = first.value;
  let cur = first.nextIdx;
  let totalLits = first.literalCount;

  while (
    cur < tokens.length &&
    tokens[cur].type === 'Punctuator' &&
    tokens[cur].value === '+'
  ) {
    const nextAtom = tryEvalStringAtom(tokens, cur + 1, constEnv);
    if (!nextAtom) break;
    // Do not absorb if followed by higher-precedence binary operator
    const afterOp = tokens[nextAtom.nextIdx];
    if (afterOp && afterOp.type === 'Punctuator' && SINGLE_ASSIGN_OP_EXCLUDED.has(afterOp.value)) {
      break;
    }
    result += nextAtom.value;
    cur = nextAtom.nextIdx;
    totalLits += nextAtom.literalCount;
  }

  return { value: result, nextIdx: cur, literalCount: totalLits };
}

function buildConstStringEnv(tokens) {
  const env = new Map();
  // Collect simple declarations: const/let/var x = <string expr>
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      t.type === 'Identifier' &&
      (t.value === 'const' || t.value === 'let' || t.value === 'var')
    ) {
      let j = i + 1;
      while (j < tokens.length) {
        const nameTok = tokens[j];
        if (!nameTok || nameTok.type !== 'Identifier') break;
        const eqTok = tokens[j + 1];
        if (eqTok && eqTok.type === 'Punctuator' && eqTok.value === '=') {
          const evalRes = tryEvalStringExpr(tokens, j + 2, env);
          if (evalRes) {
            if (env.has(nameTok.value)) {
              env.set(nameTok.value, NON_CONST_SENTINEL);
            } else {
              env.set(nameTok.value, evalRes.value);
            }
            j = evalRes.nextIdx;
          } else {
            env.set(nameTok.value, NON_CONST_SENTINEL);
            break;
          }
        } else {
          break;
        }
        if (tokens[j] && tokens[j].type === 'Punctuator' && tokens[j].value === ',') {
          j += 1;
          continue;
        }
        break;
      }
    } else if (
      t.type === 'Identifier' &&
      tokens[i + 1] &&
      tokens[i + 1].type === 'Punctuator' &&
      (tokens[i + 1].value === '=' ||
        tokens[i + 1].value === '+=' ||
        tokens[i + 1].value === '++' ||
        tokens[i + 1].value === '--')
    ) {
      const prev = tokens[i - 1];
      if (!prev || prev.type !== 'Identifier' || (prev.value !== 'const' && prev.value !== 'let' && prev.value !== 'var')) {
        env.set(t.value, NON_CONST_SENTINEL);
      }
    }
  }
  return env;
}

/**
 * Validates untrusted task code using escape normalization, lexical/AST-style
 * token scanning, string-concatenation obfuscation detection, computed property
 * inspection, delimiter balance checks, and compile-only V8 syntax verification.
 * @param {string} taskCode
 * @param {{ maxCodeLength?: number }} [options]
 * @returns {{ valid: boolean, error?: string, normalizedCode?: string }}
 */
function validateTaskCode(taskCode, options = {}) {
  const maxLen =
    options && typeof options.maxCodeLength === 'number' && Number.isFinite(options.maxCodeLength) && options.maxCodeLength > 0
      ? options.maxCodeLength
      : DEFAULT_MAX_CODE_LENGTH;

  if (typeof taskCode !== 'string' || taskCode.trim().length === 0) {
    return { valid: false, error: 'Invalid taskCode: must be a non-empty string' };
  }
  if (taskCode.length > maxLen) {
    return { valid: false, error: `Invalid taskCode: length ${taskCode.length} exceeds maximum allowed ${maxLen} bytes` };
  }
  if (taskCode.includes('\u0000') || taskCode.includes('\uFFFD') || hasLoneSurrogate(taskCode)) {
    return { valid: false, error: 'Security violation: null byte or invalid UTF-8/UTF-16 sequence detected' };
  }

  let normalizedCode;
  try {
    normalizedCode = normalizeTaskCode(taskCode);
  } catch (err) {
    return { valid: false, error: `Syntax error during escape normalization: ${err.message}` };
  }

  if (normalizedCode.includes('\u0000') || normalizedCode.includes('\uFFFD') || hasLoneSurrogate(normalizedCode)) {
    return { valid: false, error: 'Security violation: null-byte injection or invalid character sequence detected', normalizedCode };
  }

  let tokens;
  try {
    tokens = tokenizeTaskCode(taskCode);
  } catch (err) {
    return { valid: false, error: `Syntax error in task code: ${err.message}`, normalizedCode };
  }

  // Check balanced (), [], {} (prevents function-wrapper breakout e.g. `})();`)
  const delimStack = [];
  for (const t of tokens) {
    if (t.type === 'Punctuator') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        delimStack.push(t.value);
      } else if (t.value === ')' || t.value === ']' || t.value === '}') {
        const expected = t.value === ')' ? '(' : t.value === ']' ? '[' : '{';
        if (delimStack.length === 0 || delimStack[delimStack.length - 1] !== expected) {
          return {
            valid: false,
            error: `Syntax error: unmatched delimiter "${t.value}" in task code`,
            normalizedCode
          };
        }
        delimStack.pop();
      }
    }
  }
  if (delimStack.length > 0) {
    return {
      valid: false,
      error: `Syntax error: unclosed delimiter "${delimStack[delimStack.length - 1]}" in task code`,
      normalizedCode
    };
  }

  // Check all identifiers and decoded strings/templates against forbidden list
  for (const t of tokens) {
    if (t.type === 'Identifier') {
      if (FORBIDDEN_IDENTIFIERS.has(t.value)) {
        return {
          valid: false,
          error: `Forbidden identifier detected: "${t.value}"`,
          normalizedCode
        };
      }
    } else if (
      t.type === 'String' ||
      t.type === 'TemplateNoSub' ||
      t.type === 'TemplateHead' ||
      t.type === 'TemplateMid' ||
      t.type === 'TemplateTail'
    ) {
      if (t.value.includes('\u0000')) {
        return {
          valid: false,
          error: 'Security violation: null-byte injection detected in string literal',
          normalizedCode
        };
      }
      const badWord = findForbiddenWordInString(t.value);
      if (badWord) {
        return {
          valid: false,
          error: `Forbidden token detected in string literal: "${badWord}"`,
          normalizedCode
        };
      }
    }
  }

  // Check folded string concatenations, templates, array.join, fromCharCode & simple const bindings
  const constEnv = buildConstStringEnv(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    if (prev && prev.type === 'Punctuator' && SINGLE_ASSIGN_OP_EXCLUDED.has(prev.value)) {
      continue;
    }
    const evalRes = tryEvalStringExpr(tokens, i, constEnv);
    if (evalRes) {
      if (evalRes.value.includes('\u0000')) {
        return {
          valid: false,
          error: 'Security violation: obfuscated null byte detected',
          normalizedCode
        };
      }
      const badWord = findForbiddenWordInString(evalRes.value);
      if (badWord) {
        return {
          valid: false,
          error: `Forbidden obfuscated token detected: "${badWord}"`,
          normalizedCode
        };
      }
    }
  }

  // Check suspicious computed bracket property access: target[...] or target?.[ ... ]
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'Punctuator' || t.value !== '[') continue;

    const prev = tokens[i - 1];
    const targetTok = prev && prev.type === 'Punctuator' && prev.value === '?.' ? tokens[i - 2] : prev;
    const isOptionalAccess = prev && prev.type === 'Punctuator' && prev.value === '?.';
    const isMemberAccess =
      targetTok &&
      ((targetTok.type === 'Identifier' && !REGEX_PREFIX_KEYWORDS.has(targetTok.value) && targetTok.value !== 'else' && targetTok.value !== 'do') ||
        targetTok.type === 'String' ||
        targetTok.type === 'TemplateNoSub' ||
        targetTok.type === 'TemplateTail' ||
        (targetTok.type === 'Punctuator' && (targetTok.value === ')' || targetTok.value === ']')));

    if (!isOptionalAccess && !isMemberAccess) continue;

    // 1. Forbid any computed bracket indexing directly on `this[...]` / `this?.[...]` / `(this)[...]`
    const isParenThis =
      targetTok &&
      targetTok.type === 'Punctuator' &&
      targetTok.value === ')' &&
      i >= 4 &&
      tokens[i - 2] &&
      tokens[i - 2].type === 'Identifier' &&
      tokens[i - 2].value === 'this' &&
      tokens[i - 3] &&
      tokens[i - 3].type === 'Punctuator' &&
      tokens[i - 3].value === '(';

    if ((targetTok && targetTok.type === 'Identifier' && targetTok.value === 'this') || isParenThis) {
      return {
        valid: false,
        error: 'Security violation: suspicious computed property access on "this" is forbidden',
        normalizedCode
      };
    }

    // 2. Forbid pure constant string-concatenation obfuscation inside `[...]`
    const closeBracket = findMatchingClose(tokens, i, '[', ']');
    if (closeBracket !== -1) {
      const innerExpr = tryEvalStringExpr(tokens, i + 1, constEnv);
      if (innerExpr && innerExpr.nextIdx === closeBracket && innerExpr.literalCount >= 2) {
        return {
          valid: false,
          error: 'Security violation: suspicious computed bracket property string concatenation is forbidden',
          normalizedCode
        };
      }
    }
  }

  // Compile-only syntax check with V8 (never executed)
  try {
    new vm.Script(`"use strict";\n(function(data) {\n${taskCode}\n});`, {
      filename: 'openside-validation-check.js'
    });
  } catch (syntaxErr) {
    return {
      valid: false,
      error: `Syntax error in task code: ${syntaxErr.message}`,
      normalizedCode
    };
  }

  return { valid: true, normalizedCode };
}

/**
 * Recursively produces a canonical clone with deterministically sorted object keys.
 * @param {any} obj
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
function canonicalize(obj, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_SERIALIZATION_DEPTH) {
    throw new RangeError('Maximum canonicalization nesting depth exceeded');
  }
  if (obj === null || obj === undefined) {
    return obj;
  }
  const t = typeof obj;
  if (t === 'boolean' || t === 'number' || t === 'string' || t === 'bigint') {
    return obj;
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`Cannot canonicalize non-data type: ${t}`);
  }
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags);
  }
  if (seen.has(obj)) {
    throw new TypeError('Cannot canonicalize circular data structure');
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => canonicalize(item, seen, depth + 1));
    }
    if (obj instanceof Map) {
      const resMap = new Map();
      for (const [k, v] of obj.entries()) {
        resMap.set(canonicalize(k, seen, depth + 1), canonicalize(v, seen, depth + 1));
      }
      return resMap;
    }
    if (obj instanceof Set) {
      const resSet = new Set();
      for (const item of obj.values()) {
        resSet.add(canonicalize(item, seen, depth + 1));
      }
      return resSet;
    }
    const keys = Object.keys(obj).sort();
    const out = {};
    for (const k of keys) {
      if (k === '__proto__') continue;
      Object.defineProperty(out, k, {
        value: canonicalize(obj[k], seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Encodes host inputData into a pure JSON payload with lossless type markers
 * for undefined, NaN, Infinity, -Infinity, -0, BigInt, and Date.
 */
function encodeInputForRealm(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_SERIALIZATION_DEPTH) {
    throw new RangeError('Maximum input nesting depth exceeded');
  }

  function encodeNode(val, d) {
    if (d > MAX_SERIALIZATION_DEPTH) {
      throw new RangeError('Maximum input nesting depth exceeded');
    }
    if (val === undefined) return ['__os_undef__'];
    if (val === null) return null;

    const t = typeof val;
    if (t === 'boolean' || t === 'string') return val;
    if (t === 'bigint') return ['__os_bigint__', val.toString()];
    if (t === 'number') {
      if (Number.isNaN(val)) return ['__os_num__', 'NaN'];
      if (val === Infinity) return ['__os_num__', 'Infinity'];
      if (val === -Infinity) return ['__os_num__', '-Infinity'];
      if (Object.is(val, -0)) return ['__os_num__', '-0'];
      return val;
    }
    if (t === 'function' || t === 'symbol') {
      throw new TypeError(`Shard inputData cannot contain ${t} values`);
    }

    if (seen.has(val)) {
      throw new TypeError('Shard inputData cannot contain circular references');
    }
    seen.add(val);

    try {
      if (val instanceof Date) {
        return ['__os_date__', val.getTime()];
      }
      if (Array.isArray(val)) {
        return ['__os_arr__', val.map((item) => encodeNode(item, d + 1))];
      }
      const entries = [];
      for (const key of Object.keys(val)) {
        entries.push([key, encodeNode(val[key], d + 1)]);
      }
      return ['__os_obj__', entries];
    } finally {
      seen.delete(val);
    }
  }

  return JSON.stringify(encodeNode(value, depth));
}

function computeDeterministicSeeds(shardId, encodedInput) {
  const digest = crypto
    .createHash('sha256')
    .update(String(shardId || ''))
    .update(':')
    .update(encodedInput)
    .digest();
  return [
    digest.readUInt32BE(0),
    digest.readUInt32BE(4),
    digest.readUInt32BE(8),
    digest.readUInt32BE(12)
  ];
}

const REGEX_SOURCE_GETTER = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const REGEX_FLAGS_GETTER = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get;
const TYPED_ARRAY_CONSTRUCTORS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array
};
if (typeof Float16Array === 'function') {
  TYPED_ARRAY_CONSTRUCTORS.Float16Array = Float16Array;
}
const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, Symbol.toStringTag).get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, 'buffer').get;
const TYPED_ARRAY_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, 'byteOffset').get;
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, 'byteLength').get;

/**
 * Reconstructs a VM-realm execution output value safely into the host realm
 * without calling user-defined getters/methods (including Symbol.toStringTag)
 * or leaking VM prototypes. Optionally sorts plain object keys canonically.
 */
function reconstructInHostRealm(value, seen = new WeakSet(), depth = 0, sortKeys = true) {
  if (depth > MAX_SERIALIZATION_DEPTH) {
    throw new RangeError('Sandbox output exceeds maximum nesting depth');
  }
  if (value === null || value === undefined) {
    return value;
  }
  const t = typeof value;
  if (t === 'boolean' || t === 'number' || t === 'string' || t === 'bigint') {
    return value;
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`Sandbox output cannot contain ${t} values`);
  }

  if (seen.has(value)) {
    throw new TypeError('Sandbox output contains circular references');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const arr = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        if (Object.prototype.hasOwnProperty.call(value, i)) {
          const desc = Object.getOwnPropertyDescriptor(value, i);
          if (desc && (typeof desc.get === 'function' || typeof desc.set === 'function')) {
            throw new TypeError('Sandbox output cannot contain accessor properties');
          }
          arr[i] = reconstructInHostRealm(desc ? desc.value : undefined, seen, depth + 1, sortKeys);
        }
      }
      return arr;
    }

    // Check genuine built-in internal slots directly (never triggers Symbol.toStringTag getters)
    let dateMs;
    let isRealDate = false;
    try {
      dateMs = Date.prototype.getTime.call(value);
      isRealDate = true;
    } catch {
      isRealDate = false;
    }
    if (isRealDate) {
      return new Date(dateMs);
    }

    let regexSrc;
    let regexFlags;
    let isRealRegex = false;
    try {
      regexSrc = REGEX_SOURCE_GETTER.call(value);
      regexFlags = REGEX_FLAGS_GETTER.call(value);
      isRealRegex = true;
    } catch {
      isRealRegex = false;
    }
    if (isRealRegex) {
      return new RegExp(regexSrc, regexFlags);
    }

    let mapIter = null;
    try {
      mapIter = Map.prototype.entries.call(value);
    } catch {
      mapIter = null;
    }
    if (mapIter !== null) {
      const hostMap = new Map();
      for (const entry of mapIter) {
        hostMap.set(
          reconstructInHostRealm(entry[0], seen, depth + 1, sortKeys),
          reconstructInHostRealm(entry[1], seen, depth + 1, sortKeys)
        );
      }
      return hostMap;
    }

    let setIter = null;
    try {
      setIter = Set.prototype.values.call(value);
    } catch {
      setIter = null;
    }
    if (setIter !== null) {
      const hostSet = new Set();
      for (const item of setIter) {
        hostSet.add(reconstructInHostRealm(item, seen, depth + 1, sortKeys));
      }
      return hostSet;
    }

    if (ArrayBuffer.isView(value)) {
      const taName = TYPED_ARRAY_TAG_GETTER.call(value);
      if (taName && Object.prototype.hasOwnProperty.call(TYPED_ARRAY_CONSTRUCTORS, taName)) {
        const HostCtor = TYPED_ARRAY_CONSTRUCTORS[taName];
        const buf = TYPED_ARRAY_BUFFER_GETTER.call(value);
        const offset = TYPED_ARRAY_OFFSET_GETTER.call(value);
        const byteLen = TYPED_ARRAY_LENGTH_GETTER.call(value);
        const copiedBuf = ArrayBuffer.prototype.slice.call(buf, offset, offset + byteLen);
        return new HostCtor(copiedBuf);
      }
    }

    const out = {};
    const keys = sortKeys ? Object.keys(value).sort() : Object.keys(value);
    for (const key of keys) {
      if (key === '__proto__') continue;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) continue;
      if (typeof desc.get === 'function' || typeof desc.set === 'function') {
        throw new TypeError('Sandbox output cannot contain accessor properties');
      }
      Object.defineProperty(out, key, {
        value: reconstructInHostRealm(desc.value, seen, depth + 1, sortKeys),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function safeReadErrorDataProp(obj, prop) {
  let cur = obj;
  let hops = 0;
  while (cur && typeof cur === 'object' && hops < 8) {
    const desc = Object.getOwnPropertyDescriptor(cur, prop);
    if (desc) {
      if ('value' in desc && typeof desc.value === 'string') {
        return desc.value;
      }
      return undefined;
    }
    cur = Object.getPrototypeOf(cur);
    hops += 1;
  }
  return undefined;
}

function reconstructHostError(err) {
  if (err instanceof Error) {
    return err;
  }
  let name = 'Error';
  let message = 'Sandbox execution error';
  let code;
  try {
    if (err && typeof err === 'object') {
      const readName = safeReadErrorDataProp(err, 'name');
      const readMessage = safeReadErrorDataProp(err, 'message');
      const readCode = safeReadErrorDataProp(err, 'code');
      if (readName !== undefined) name = readName;
      if (readMessage !== undefined) message = readMessage;
      if (readCode !== undefined) code = readCode;
    } else {
      message = String(err);
    }
  } catch {
    message = 'Sandbox execution failed with unreadable error';
  }

  return buildErrorByName(name, message, code);
}

function buildErrorByName(name, message, code) {
  const errorMap = {
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
    Error
  };
  const Ctor = Object.prototype.hasOwnProperty.call(errorMap, name) ? errorMap[name] : Error;
  const hostErr = new Ctor(message);
  if (name && Ctor === Error && name !== 'Error') {
    hostErr.name = name;
  }
  if (code) {
    hostErr.code = code;
  }
  return hostErr;
}

// Pure VM-side bootstrap script: runs inside each newly created VM realm.
// Reads primitive init fields from globalThis, deletes them, locks down globals
// & prototypes, virtualizes deterministic primitives, and deep-freezes inputData.
const VM_BOOTSTRAP_CODE = `
"use strict";
(function() {
  const encodedInput = globalThis.__os_encoded_input;
  const deterministic = Boolean(globalThis.__os_deterministic);
  const virtualNow = Number(globalThis.__os_virtual_now);
  let s0 = globalThis.__os_seed0 >>> 0;
  let s1 = globalThis.__os_seed1 >>> 0;
  let s2 = globalThis.__os_seed2 >>> 0;
  let s3 = globalThis.__os_seed3 >>> 0;

  delete globalThis.__os_encoded_input;
  delete globalThis.__os_deterministic;
  delete globalThis.__os_virtual_now;
  delete globalThis.__os_seed0;
  delete globalThis.__os_seed1;
  delete globalThis.__os_seed2;
  delete globalThis.__os_seed3;

  const FnCtor = globalThis.Function;
  const FnProto = FnCtor.prototype;
  const Obj = globalThis.Object;
  const Arr = globalThis.Array;
  const NativeDate = globalThis.Date;
  const NativeMath = globalThis.Math;
  const NativeJSON = globalThis.JSON;
  const NativeError = globalThis.Error;
  const NativeBigInt = globalThis.BigInt;
  const NativeNumber = globalThis.Number;
  const NativeSet = globalThis.Set;

  // Strip dangerous capabilities from VM globalThis
  try { delete globalThis.WebAssembly; } catch {}
  try { delete globalThis.Proxy; } catch {}
  try { delete globalThis.Reflect; } catch {}
  try { delete globalThis.SharedArrayBuffer; } catch {}
  try { delete globalThis.Atomics; } catch {}
  try { delete globalThis.FinalizationRegistry; } catch {}
  try { delete globalThis.WeakRef; } catch {}
  try { delete globalThis.eval; } catch {}
  try { delete globalThis.Function; } catch {}

  const noop = Obj.freeze(function() {});
  globalThis.console = Obj.freeze({
    log: noop,
    warn: noop,
    error: noop,
    info: noop,
    debug: noop
  });

  // Decode tagged input strictly inside VM realm (zero host references)
  const jsonParse = NativeJSON.parse;
  const isArr = Arr.isArray;
  const defineProp = Obj.defineProperty;
  const objKeys = Obj.keys;
  const freeze = Obj.freeze;

  function decodeNode(node) {
    if (node === null || typeof node !== 'object') return node;
    if (!isArr(node)) return node;
    const tag = node[0];
    if (tag === '__os_undef__') return undefined;
    if (tag === '__os_bigint__') return NativeBigInt(node[1]);
    if (tag === '__os_num__') {
      if (node[1] === 'NaN') return NaN;
      if (node[1] === 'Infinity') return Infinity;
      if (node[1] === '-Infinity') return -Infinity;
      if (node[1] === '-0') return -0;
      return NativeNumber(node[1]);
    }
    if (tag === '__os_date__') return new NativeDate(node[1]);
    if (tag === '__os_arr__') {
      const items = node[1];
      const res = new Arr(items.length);
      for (let i = 0; i < items.length; i++) {
        res[i] = decodeNode(items[i]);
      }
      return res;
    }
    if (tag === '__os_obj__') {
      const entries = node[1];
      const obj = {};
      for (let i = 0; i < entries.length; i++) {
        const k = entries[i][0];
        if (k === '__proto__') continue;
        defineProp(obj, k, {
          value: decodeNode(entries[i][1]),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return obj;
    }
    return node;
  }

  function deepFreeze(val, seen) {
    if (val === null || (typeof val !== 'object' && typeof val !== 'function')) {
      return val;
    }
    if (seen.has(val)) return val;
    seen.add(val);
    const keys = objKeys(val);
    for (let i = 0; i < keys.length; i++) {
      deepFreeze(val[keys[i]], seen);
    }
    return freeze(val);
  }

  const decodedInput = decodeNode(jsonParse(encodedInput));
  globalThis.__os_input = deepFreeze(decodedInput, new NativeSet());

  // Deterministic virtualization (Date, Math.random, performance, canonicalize)
  if (deterministic) {
    if ((s0 | s1 | s2 | s3) === 0) {
      s0 = 0x9E3779B9;
      s1 = 0x243F6A88;
      s2 = 0xB7E15162;
      s3 = 0x8AED2A6B;
    }
    NativeMath.random = freeze(function random() {
      let t = s3;
      const s = s0;
      s3 = s2;
      s2 = s1;
      s1 = s;
      t ^= t << 11;
      t ^= t >>> 8;
      s0 = t ^ s ^ (s >>> 19);
      return (s0 >>> 0) / 4294967296;
    });

    function VirtualDate(...args) {
      if (!new.target) {
        return new NativeDate(virtualNow).toUTCString();
      }
      if (args.length === 0) {
        return new NativeDate(virtualNow);
      }
      if (args.length === 1) {
        return new NativeDate(args[0]);
      }
      return new NativeDate(NativeDate.UTC(...args));
    }
    VirtualDate.now = freeze(function now() { return virtualNow; });
    VirtualDate.UTC = NativeDate.UTC;
    VirtualDate.parse = NativeDate.parse;
    VirtualDate.prototype = NativeDate.prototype;

    NativeDate.prototype.getTimezoneOffset = freeze(function getTimezoneOffset() { return 0; });
    NativeDate.prototype.getFullYear = freeze(function getFullYear() { return this.getUTCFullYear(); });
    NativeDate.prototype.getYear = freeze(function getYear() { return this.getUTCFullYear() - 1900; });
    NativeDate.prototype.getMonth = freeze(function getMonth() { return this.getUTCMonth(); });
    NativeDate.prototype.getDate = freeze(function getDate() { return this.getUTCDate(); });
    NativeDate.prototype.getDay = freeze(function getDay() { return this.getUTCDay(); });
    NativeDate.prototype.getHours = freeze(function getHours() { return this.getUTCHours(); });
    NativeDate.prototype.getMinutes = freeze(function getMinutes() { return this.getUTCMinutes(); });
    NativeDate.prototype.getSeconds = freeze(function getSeconds() { return this.getUTCSeconds(); });
    NativeDate.prototype.getMilliseconds = freeze(function getMilliseconds() { return this.getUTCMilliseconds(); });
    NativeDate.prototype.toString = freeze(function toString() { return this.toUTCString(); });
    NativeDate.prototype.toDateString = freeze(function toDateString() { return this.toUTCString().slice(0, 16); });
    NativeDate.prototype.toTimeString = freeze(function toTimeString() { return this.toUTCString().slice(17); });
    NativeDate.prototype.constructor = VirtualDate;

    globalThis.Date = freeze(VirtualDate);
    globalThis.performance = freeze({
      now: freeze(function now() { return 0; }),
      timeOrigin: virtualNow
    });
  }

  globalThis.canonicalize = freeze(function canonicalizeInVm(val, seen) {
    if (!seen) seen = new NativeSet();
    if (val === null || val === undefined || typeof val !== 'object') return val;
    if (seen.has(val)) throw new globalThis.TypeError('Cannot canonicalize circular structure');
    seen.add(val);
    try {
      if (isArr(val)) {
        return val.map((el) => canonicalizeInVm(el, seen));
      }
      const ks = objKeys(val).sort();
      const out = {};
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i];
        if (k === '__proto__') continue;
        defineProp(out, k, {
          value: canonicalizeInVm(val[k], seen),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
      return out;
    } finally {
      seen.delete(val);
    }
  });

  // Neutralize prototype mutation & stack-trace escape vectors after VM setup
  try { delete Obj.prototype.__proto__; } catch {}
  try { delete Obj.prototype.__defineGetter__; } catch {}
  try { delete Obj.prototype.__defineSetter__; } catch {}
  try { delete Obj.prototype.__lookupGetter__; } catch {}
  try { delete Obj.prototype.__lookupSetter__; } catch {}
  try { delete Obj.setPrototypeOf; } catch {}
  try { delete Obj.defineProperty; } catch {}
  try { delete Obj.defineProperties; } catch {}
  try { delete NativeError.prepareStackTrace; } catch {}

  const protos = [
    Obj.prototype,
    Arr.prototype,
    globalThis.String.prototype,
    NativeNumber.prototype,
    globalThis.Boolean.prototype,
    NativeDate.prototype,
    globalThis.RegExp.prototype,
    NativeError.prototype,
    globalThis.TypeError.prototype,
    globalThis.RangeError.prototype,
    globalThis.SyntaxError.prototype,
    globalThis.EvalError.prototype,
    globalThis.Map.prototype,
    NativeSet.prototype,
    globalThis.Promise.prototype,
    FnProto
  ];
  for (let i = 0; i < protos.length; i++) {
    freeze(protos[i]);
  }

  const ctors = [
    Obj,
    Arr,
    globalThis.String,
    NativeNumber,
    globalThis.Boolean,
    NativeDate,
    globalThis.RegExp,
    NativeError,
    globalThis.TypeError,
    globalThis.RangeError,
    globalThis.SyntaxError,
    globalThis.EvalError,
    NativeMath,
    NativeJSON,
    globalThis.Map,
    NativeSet,
    globalThis.Promise,
    FnCtor
  ];
  for (let i = 0; i < ctors.length; i++) {
    freeze(ctors[i]);
  }
})();
`;

const VM_BOOTSTRAP_SCRIPT = new vm.Script(VM_BOOTSTRAP_CODE, {
  filename: 'openside-vm-bootstrap.js'
});

const WORKER_BOOTSTRAP_SCRIPT = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

const MAX_DEPTH = ${MAX_SERIALIZATION_DEPTH};
const REGEX_SRC = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const REGEX_FLG = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get;
const TA_CTORS = {
  '[object Int8Array]': Int8Array,
  '[object Uint8Array]': Uint8Array,
  '[object Uint8ClampedArray]': Uint8ClampedArray,
  '[object Int16Array]': Int16Array,
  '[object Uint16Array]': Uint16Array,
  '[object Int32Array]': Int32Array,
  '[object Uint32Array]': Uint32Array,
  '[object Float32Array]': Float32Array,
  '[object Float64Array]': Float64Array,
  '[object BigInt64Array]': BigInt64Array,
  '[object BigUint64Array]': BigUint64Array
};
const TA_BUF = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const TA_OFF = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteOffset').get;
const TA_LEN = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;

function toHost(val, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) throw new RangeError('Sandbox output exceeds maximum nesting depth');
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === 'boolean' || t === 'number' || t === 'string' || t === 'bigint') return val;
  if (t === 'function' || t === 'symbol') throw new TypeError('Sandbox output cannot contain ' + t + ' values');
  if (seen.has(val)) throw new TypeError('Sandbox output contains circular references');
  seen.add(val);
  try {
    if (Array.isArray(val)) {
      const arr = new Array(val.length);
      for (let i = 0; i < val.length; i++) {
        if (Object.prototype.hasOwnProperty.call(val, i)) {
          const desc = Object.getOwnPropertyDescriptor(val, i);
          if (desc && typeof desc.get === 'function') throw new TypeError('Sandbox output cannot contain accessor properties');
          arr[i] = toHost(desc ? desc.value : undefined, seen, depth + 1);
        }
      }
      return arr;
    }
    const tag = Object.prototype.toString.call(val);
    if (tag === '[object Date]') {
      try { return new Date(Date.prototype.getTime.call(val)); } catch {}
    }
    if (tag === '[object RegExp]') {
      try { return new RegExp(REGEX_SRC.call(val), REGEX_FLG.call(val)); } catch {}
    }
    if (tag === '[object Map]') {
      try {
        const m = new Map();
        for (const [k, v] of Map.prototype.entries.call(val)) {
          m.set(toHost(k, seen, depth + 1), toHost(v, seen, depth + 1));
        }
        return m;
      } catch {}
    }
    if (tag === '[object Set]') {
      try {
        const s = new Set();
        for (const item of Set.prototype.values.call(val)) {
          s.add(toHost(item, seen, depth + 1));
        }
        return s;
      } catch {}
    }
    if (ArrayBuffer.isView(val) && Object.prototype.hasOwnProperty.call(TA_CTORS, tag)) {
      const C = TA_CTORS[tag];
      const buf = TA_BUF.call(val);
      const off = TA_OFF.call(val);
      const len = TA_LEN.call(val);
      return new C(ArrayBuffer.prototype.slice.call(buf, off, off + len));
    }
    const out = {};
    for (const k of Object.keys(val).sort()) {
      if (k === '__proto__') continue;
      const desc = Object.getOwnPropertyDescriptor(val, k);
      if (!desc) continue;
      if (typeof desc.get === 'function' || typeof desc.set === 'function') {
        throw new TypeError('Sandbox output cannot contain accessor properties');
      }
      Object.defineProperty(out, k, {
        value: toHost(desc.value, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return out;
  } finally {
    seen.delete(val);
  }
}

if (workerData && workerData.isPoolWorker) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'PING') {
      parentPort.postMessage({ id: msg.id, type: 'PONG' });
      return;
    }
    if (msg.type === 'SHUTDOWN') {
      process.exit(0);
      return;
    }
    if (msg.type === 'EXECUTE') {
      try {
        const ctx = vm.createContext(Object.create(null), {
          name: 'openside-worker-shard',
          codeGeneration: { strings: false, wasm: false },
          microtaskMode: 'afterEvaluate'
        });
        ctx.__os_encoded_input = msg.encodedInput;
        ctx.__os_deterministic = msg.deterministic;
        ctx.__os_virtual_now = msg.virtualTimestamp;
        ctx.__os_seed0 = msg.seed0;
        ctx.__os_seed1 = msg.seed1;
        ctx.__os_seed2 = msg.seed2;
        ctx.__os_seed3 = msg.seed3;

        vm.runInContext(msg.bootstrapCode, ctx, { displayErrors: false });

        const script = new vm.Script(
          '"use strict";\\n(function(data) {\\n' +
            msg.taskCode +
            '\\n})((() => { const v = __os_input; delete globalThis.__os_input; return v; })());',
          { filename: 'openside-shard.js' }
        );

        const startNs = process.hrtime.bigint();
        const rawOutput = script.runInContext(ctx, {
          timeout: msg.timeoutMs,
          breakOnSigint: true,
          displayErrors: false
        });
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        const executionTimeMs = Number(elapsedMs.toFixed(4)) || 0.0001;
        const output = toHost(rawOutput);

        try {
          parentPort.postMessage({
            id: msg.id,
            ok: true,
            shardId: msg.shardId,
            output,
            executionTimeMs
          });
        } catch (cloneErr) {
          parentPort.postMessage({
            id: msg.id,
            ok: false,
            errorName: (cloneErr && cloneErr.name) || 'Error',
            error: 'Output serialization failed: ' + ((cloneErr && cloneErr.message) || String(cloneErr))
          });
        }
      } catch (err) {
        let errorName = 'Error';
        let error = 'Worker sandbox execution failed';
        let errorCode;
        try {
          if (err && typeof err === 'object') {
            const nDesc = Object.getOwnPropertyDescriptor(err, 'name');
            const mDesc = Object.getOwnPropertyDescriptor(err, 'message');
            const cDesc = Object.getOwnPropertyDescriptor(err, 'code');
            errorName = (nDesc && typeof nDesc.value === 'string') ? nDesc.value : (typeof err.name === 'string' ? err.name : 'Error');
            error = (mDesc && typeof mDesc.value === 'string') ? mDesc.value : (typeof err.message === 'string' ? err.message : String(err));
            if (cDesc && typeof cDesc.value === 'string') errorCode = cDesc.value;
          } else {
            error = String(err);
          }
        } catch {
          error = 'Worker execution failed with unreadable error';
        }
        parentPort.postMessage({ id: msg.id, ok: false, errorName, error, errorCode });
      }
    }
  });
  parentPort.postMessage({ type: 'READY' });
} else {
  try {
    const ctx = vm.createContext(Object.create(null), {
      name: 'openside-worker-shard',
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate'
    });
    ctx.__os_encoded_input = workerData.encodedInput;
    ctx.__os_deterministic = workerData.deterministic;
    ctx.__os_virtual_now = workerData.virtualTimestamp;
    ctx.__os_seed0 = workerData.seed0;
    ctx.__os_seed1 = workerData.seed1;
    ctx.__os_seed2 = workerData.seed2;
    ctx.__os_seed3 = workerData.seed3;

    vm.runInContext(workerData.bootstrapCode, ctx, { displayErrors: false });

    const script = new vm.Script(
      '"use strict";\\n(function(data) {\\n' +
        workerData.taskCode +
        '\\n})((() => { const v = __os_input; delete globalThis.__os_input; return v; })());',
      { filename: 'openside-shard.js' }
    );

    const startNs = process.hrtime.bigint();
    const rawOutput = script.runInContext(ctx, {
      timeout: workerData.timeoutMs,
      breakOnSigint: true,
      displayErrors: false
    });
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const executionTimeMs = Number(elapsedMs.toFixed(4)) || 0.0001;
    const output = toHost(rawOutput);

    try {
      parentPort.postMessage({
        ok: true,
        shardId: workerData.shardId,
        output,
        executionTimeMs
      });
    } catch (cloneErr) {
      parentPort.postMessage({
        ok: false,
        errorName: (cloneErr && cloneErr.name) || 'Error',
        error: 'Output serialization failed: ' + ((cloneErr && cloneErr.message) || String(cloneErr))
      });
    }
  } catch (err) {
    let errorName = 'Error';
    let error = 'Worker sandbox execution failed';
    let errorCode;
    try {
      if (err && typeof err === 'object') {
        const nDesc = Object.getOwnPropertyDescriptor(err, 'name');
        const mDesc = Object.getOwnPropertyDescriptor(err, 'message');
        const cDesc = Object.getOwnPropertyDescriptor(err, 'code');
        errorName = (nDesc && typeof nDesc.value === 'string') ? nDesc.value : (typeof err.name === 'string' ? err.name : 'Error');
        error = (mDesc && typeof mDesc.value === 'string') ? mDesc.value : (typeof err.message === 'string' ? err.message : String(err));
        if (cDesc && typeof cDesc.value === 'string') errorCode = cDesc.value;
      } else {
        error = String(err);
      }
    } catch {
      error = 'Worker execution failed with unreadable error';
    }
    parentPort.postMessage({ ok: false, errorName, error, errorCode });
  }
}
`;

class StandbyWorkerPool {
  /**
   * Elastic Zero-Waste Standby Worker Pool.
   * Keeps minWarm workers ready for <5ms instant execution.
   * Scales dynamically up to maxWorkers (N-1 CPU cores) under load.
   * Scales down surplus idle workers after idleTimeoutMs to preserve host memory.
   * @param {object} [options]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.minWarm = opts.minWarm !== undefined ? Math.max(0, opts.minWarm) : 1;
    this.maxWorkers = opts.maxWorkers !== undefined
      ? Math.max(1, opts.maxWorkers)
      : Math.max(1, (os.cpus()?.length || 4) - 1);
    if (this.maxWorkers < this.minWarm) {
      this.maxWorkers = this.minWarm;
    }
    this.idleTimeoutMs = opts.idleTimeoutMs !== undefined ? Math.max(1000, opts.idleTimeoutMs) : 10000;
    this.memoryLimitMb = opts.memoryLimitMb !== undefined ? opts.memoryLimitMb : DEFAULT_MAX_MEMORY_MB;
    this.maxExecutionMs = opts.maxExecutionMs !== undefined ? opts.maxExecutionMs : DEFAULT_MAX_EXECUTION_MS;
    this.deterministic = opts.deterministic !== undefined ? Boolean(opts.deterministic) : true;
    this.virtualTimestamp = opts.virtualTimestamp !== undefined ? opts.virtualTimestamp : DEFAULT_VIRTUAL_TIMESTAMP;

    this._workers = new Set();
    this._idleWorkers = [];
    this._activeJobs = new Map();
    this._jobQueue = [];
    this._closed = false;

    for (let i = 0; i < this.minWarm; i++) {
      this._spawnWorker();
    }
  }

  _spawnWorker() {
    if (this._closed) return null;
    const worker = new Worker(WORKER_BOOTSTRAP_SCRIPT, {
      eval: true,
      workerData: {
        isPoolWorker: true
      },
      resourceLimits: {
        maxOldGenerationSizeMb: this.memoryLimitMb,
        maxYoungGenerationSizeMb: Math.max(8, Math.floor(this.memoryLimitMb / 4))
      }
    });

    const workerEntry = {
      worker,
      ready: false,
      idleTimer: null,
      currentJobId: null
    };

    this._workers.add(workerEntry);

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'READY') {
        workerEntry.ready = true;
        this._returnWorkerToIdle(workerEntry);
        return;
      }
      if (msg.id && this._activeJobs.has(workerEntry)) {
        const active = this._activeJobs.get(workerEntry);
        if (active && active.jobId === msg.id) {
          this._activeJobs.delete(workerEntry);
          workerEntry.currentJobId = null;
          if (active.timer) {
            clearTimeout(active.timer);
          }
          if (msg.ok) {
            active.resolve({
              shardId: msg.shardId,
              output: msg.output,
              executionTimeMs: msg.executionTimeMs
            });
          } else {
            active.reject(buildErrorByName(msg.errorName || 'Error', msg.error || 'Worker execution failed', msg.errorCode));
          }
          this._returnWorkerToIdle(workerEntry);
        }
      }
    });

    worker.on('error', (err) => {
      this._handleWorkerFailure(workerEntry, err);
    });

    worker.on('exit', (code) => {
      this._handleWorkerFailure(workerEntry, new Error(`Worker exited with code ${code}`));
    });

    return workerEntry;
  }

  _returnWorkerToIdle(workerEntry) {
    if (this._closed || !this._workers.has(workerEntry)) return;

    if (this._jobQueue.length > 0) {
      const next = this._jobQueue.shift();
      this._dispatchToWorker(workerEntry, next.job, next.resolve, next.reject, next.timeoutMs);
      return;
    }

    if (!this._idleWorkers.includes(workerEntry)) {
      this._idleWorkers.push(workerEntry);
    }

    if (this._workers.size > this.minWarm) {
      if (workerEntry.idleTimer) clearTimeout(workerEntry.idleTimer);
      workerEntry.idleTimer = setTimeout(() => {
        this._retireWorker(workerEntry);
      }, this.idleTimeoutMs);
      if (typeof workerEntry.idleTimer.unref === 'function') {
        workerEntry.idleTimer.unref();
      }
    }
  }

  _retireWorker(workerEntry) {
    if (this._closed) return;
    if (this._workers.size <= this.minWarm) return;
    if (this._activeJobs.has(workerEntry)) return;

    const idx = this._idleWorkers.indexOf(workerEntry);
    if (idx !== -1) {
      this._idleWorkers.splice(idx, 1);
    }
    this._workers.delete(workerEntry);
    if (workerEntry.idleTimer) {
      clearTimeout(workerEntry.idleTimer);
      workerEntry.idleTimer = null;
    }
    workerEntry.worker.terminate().catch(() => {});
  }

  _handleWorkerFailure(workerEntry, err) {
    if (!this._workers.has(workerEntry)) return;

    if (workerEntry.idleTimer) {
      clearTimeout(workerEntry.idleTimer);
      workerEntry.idleTimer = null;
    }

    const idx = this._idleWorkers.indexOf(workerEntry);
    if (idx !== -1) {
      this._idleWorkers.splice(idx, 1);
    }

    const active = this._activeJobs.get(workerEntry);
    if (active) {
      this._activeJobs.delete(workerEntry);
      workerEntry.currentJobId = null;
      if (active.timer) clearTimeout(active.timer);
      const wrapped = err instanceof Error ? err : new Error(String(err));
      active.reject(wrapped);
    }

    this._workers.delete(workerEntry);
    workerEntry.worker.terminate().catch(() => {});

    if (this._workers.size < this.minWarm && !this._closed) {
      this._spawnWorker();
    }
  }

  _dispatchToWorker(workerEntry, job, resolve, reject, timeoutMs) {
    if (workerEntry.idleTimer) {
      clearTimeout(workerEntry.idleTimer);
      workerEntry.idleTimer = null;
    }

    const timer = setTimeout(() => {
      this._handleWorkerFailure(workerEntry, new Error(`Sandbox worker execution timed out after ${timeoutMs}ms`));
    }, timeoutMs + 25);
    if (typeof timer.unref === 'function') timer.unref();

    this._activeJobs.set(workerEntry, {
      jobId: job.id,
      resolve,
      reject,
      timer
    });
    workerEntry.currentJobId = job.id;
    workerEntry.worker.postMessage(job);
  }

  async execute(shard, options = {}) {
    if (this._closed) {
      throw new Error('StandbyWorkerPool is closed');
    }

    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : this.maxExecutionMs;
    const encodedInput = encodeInputForRealm(shard.inputData);
    const [seed0, seed1, seed2, seed3] = computeDeterministicSeeds(shard.shardId, encodedInput);
    const jobId = crypto.randomUUID();

    const job = {
      type: 'EXECUTE',
      id: jobId,
      shardId: shard.shardId,
      taskCode: shard.taskCode,
      encodedInput,
      deterministic: this.deterministic,
      virtualTimestamp: this.virtualTimestamp,
      seed0,
      seed1,
      seed2,
      seed3,
      timeoutMs,
      bootstrapCode: VM_BOOTSTRAP_CODE
    };

    return new Promise((resolve, reject) => {
      const readyIdleIdx = this._idleWorkers.findIndex((w) => w.ready);
      if (readyIdleIdx !== -1) {
        const workerEntry = this._idleWorkers.splice(readyIdleIdx, 1)[0];
        this._dispatchToWorker(workerEntry, job, resolve, reject, timeoutMs);
        return;
      }

      if (this._workers.size < this.maxWorkers) {
        this._spawnWorker();
        this._jobQueue.push({ job, resolve, reject, timeoutMs });
        return;
      }

      this._jobQueue.push({ job, resolve, reject, timeoutMs });
    });
  }

  getPoolStats() {
    return {
      totalWorkers: this._workers.size,
      idleWorkers: this._idleWorkers.filter((w) => w.ready).length,
      busyWorkers: this._activeJobs.size,
      queuedJobs: this._jobQueue.length,
      minWarm: this.minWarm,
      maxWorkers: this.maxWorkers
    };
  }

  async terminateAllWorkers() {
    this._closed = true;
    for (const q of this._jobQueue) {
      q.reject(new Error('StandbyWorkerPool terminated'));
    }
    this._jobQueue = [];

    const terminations = [];
    for (const entry of this._workers) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      terminations.push(entry.worker.terminate().catch(() => {}));
    }
    this._workers.clear();
    this._idleWorkers = [];
    this._activeJobs.clear();
    await Promise.allSettled(terminations);
  }
}

function extractCpuSnapshot(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) {
    return null;
  }
  let totalIdle = 0n;
  let totalTicks = 0n;
  for (const cpu of cpus) {
    if (!cpu || typeof cpu !== 'object' || !cpu.times || typeof cpu.times !== 'object') {
      return null;
    }
    const { user, nice, sys, idle, irq } = cpu.times;
    if (idle === undefined && user === undefined && sys === undefined) {
      return null;
    }
    const toTick = (v) => {
      if (v === undefined) return 0n;
      if (typeof v === 'bigint') return v >= 0n ? v : null;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.trunc(v));
      return null;
    };
    const u = toTick(user);
    const n = toTick(nice);
    const s = toTick(sys);
    const id = toTick(idle);
    const iq = toTick(irq);
    if (u === null || n === null || s === null || id === null || iq === null) {
      return null;
    }
    totalIdle += id;
    totalTicks += u + n + s + id + iq;
  }
  return { totalIdle, totalTicks };
}

class StandbySandbox {
  /**
   * @param {object} [config]
   * @param {number} [config.maxExecutionMs=1500]
   * @param {number} [config.maxMemoryMb=64]
   * @param {number} [config.maxCpuLoadThreshold=0.85]
   * @param {boolean} [config.deterministic=true]
   * @param {number} [config.maxCodeLength=65536]
   * @param {number} [config.virtualTimestamp=1700000000000]
   */
  constructor(config = {}) {
    const cfg = config && typeof config === 'object' ? config : {};

    if (cfg.maxExecutionMs !== undefined) {
      if (typeof cfg.maxExecutionMs !== 'number' || !Number.isFinite(cfg.maxExecutionMs) || cfg.maxExecutionMs <= 0) {
        throw new RangeError('Invalid maxExecutionMs: must be a positive finite number');
      }
      this.maxExecutionMs = cfg.maxExecutionMs;
    } else {
      this.maxExecutionMs = DEFAULT_MAX_EXECUTION_MS;
    }

    if (cfg.maxMemoryMb !== undefined) {
      if (typeof cfg.maxMemoryMb !== 'number' || !Number.isFinite(cfg.maxMemoryMb) || cfg.maxMemoryMb <= 0) {
        throw new RangeError('Invalid maxMemoryMb: must be a positive finite number');
      }
      this.maxMemoryMb = cfg.maxMemoryMb;
    } else {
      this.maxMemoryMb = DEFAULT_MAX_MEMORY_MB;
    }

    if (cfg.maxCpuLoadThreshold !== undefined) {
      if (
        typeof cfg.maxCpuLoadThreshold !== 'number' ||
        !Number.isFinite(cfg.maxCpuLoadThreshold) ||
        cfg.maxCpuLoadThreshold <= 0 ||
        cfg.maxCpuLoadThreshold > 1
      ) {
        throw new RangeError('Invalid maxCpuLoadThreshold: must be a finite number in (0, 1]');
      }
      this.maxCpuLoadThreshold = cfg.maxCpuLoadThreshold;
    } else {
      this.maxCpuLoadThreshold = DEFAULT_MAX_CPU_LOAD_THRESHOLD;
    }

    if (cfg.maxCodeLength !== undefined) {
      if (!Number.isSafeInteger(cfg.maxCodeLength) || cfg.maxCodeLength <= 0) {
        throw new RangeError('Invalid maxCodeLength: must be a positive safe integer');
      }
      this.maxCodeLength = cfg.maxCodeLength;
    } else {
      this.maxCodeLength = DEFAULT_MAX_CODE_LENGTH;
    }

    if (cfg.virtualTimestamp !== undefined) {
      if (typeof cfg.virtualTimestamp !== 'number' || !Number.isFinite(cfg.virtualTimestamp)) {
        throw new RangeError('Invalid virtualTimestamp: must be a finite number');
      }
      this.virtualTimestamp = cfg.virtualTimestamp;
    } else {
      this.virtualTimestamp = DEFAULT_VIRTUAL_TIMESTAMP;
    }

    this.deterministic = cfg.deterministic !== undefined ? Boolean(cfg.deterministic) : true;
    this._os = cfg.os && typeof cfg.os === 'object' ? cfg.os : os;
    this._prevCpuSnap = null;
    this._lastCpuDeltaLoad = 0;
    this._activeWorkers = new Set();

    this.workerPool = cfg.enableWorkerPool === true
      ? new StandbyWorkerPool({
          minWarm: cfg.minWarm,
          maxWorkers: cfg.maxWorkers,
          idleTimeoutMs: cfg.idleTimeoutMs,
          memoryLimitMb: this.maxMemoryMb,
          maxExecutionMs: this.maxExecutionMs,
          deterministic: this.deterministic,
          virtualTimestamp: this.virtualTimestamp
        })
      : null;

    try {
      if (typeof this._os.cpus === 'function') {
        this._prevCpuSnap = extractCpuSnapshot(this._os.cpus());
      }
    } catch {
      this._prevCpuSnap = null;
    }
  }

  getPoolStats() {
    return this.workerPool ? this.workerPool.getPoolStats() : null;
  }

  static normalizeTaskCode(code) {
    return normalizeTaskCode(code);
  }

  normalizeTaskCode(code) {
    return normalizeTaskCode(code);
  }

  static validateTaskCode(taskCode, options = {}) {
    return validateTaskCode(taskCode, options);
  }

  validateTaskCode(taskCode, options = {}) {
    const maxCodeLength =
      options && options.maxCodeLength !== undefined ? options.maxCodeLength : this.maxCodeLength;
    return validateTaskCode(taskCode, { maxCodeLength });
  }

  static canonicalize(obj) {
    return canonicalize(obj);
  }

  canonicalize(obj) {
    return canonicalize(obj);
  }

  isDeviceInStandby() {
    let cpus = [];
    try {
      cpus = typeof this._os.cpus === 'function' ? this._os.cpus() : [];
    } catch {
      cpus = [];
    }
    const cpuCount = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : 1;

    let loadArr = [0, 0, 0];
    try {
      loadArr = typeof this._os.loadavg === 'function' ? this._os.loadavg() : [0, 0, 0];
    } catch {
      loadArr = [0, 0, 0];
    }

    const rawLoad =
      Array.isArray(loadArr) && typeof loadArr[0] === 'number' && Number.isFinite(loadArr[0]) && loadArr[0] >= 0
        ? loadArr[0]
        : 0;

    let normalizedLoad;
    if (rawLoad > 0) {
      normalizedLoad = rawLoad / cpuCount;
    } else {
      // Handle Windows os.loadavg() returning [0, 0, 0] or idle loadavg cleanly via CPU tick delta
      const currentSnap = extractCpuSnapshot(cpus);
      if (currentSnap && this._prevCpuSnap) {
        const deltaTotal = currentSnap.totalTicks - this._prevCpuSnap.totalTicks;
        const deltaIdle = currentSnap.totalIdle - this._prevCpuSnap.totalIdle;
        if (deltaTotal > 0n && deltaIdle >= 0n && deltaIdle <= deltaTotal) {
          const deltaBusy = deltaTotal - deltaIdle;
          const ratio = Number((deltaBusy * 1000000n) / deltaTotal) / 1000000;
          this._lastCpuDeltaLoad = Math.min(1, Math.max(0, ratio));
          this._prevCpuSnap = currentSnap;
        } else if (deltaTotal < 0n || deltaIdle < 0n) {
          this._lastCpuDeltaLoad = 0;
          this._prevCpuSnap = currentSnap;
        }
        normalizedLoad = this._lastCpuDeltaLoad;
      } else {
        if (currentSnap) {
          this._prevCpuSnap = currentSnap;
        }
        normalizedLoad = 0;
      }
    }

    if (!Number.isFinite(normalizedLoad) || normalizedLoad < 0) {
      normalizedLoad = 1;
    }

    let rawTotal = 0;
    let rawFree = 0;
    try {
      rawTotal = typeof this._os.totalmem === 'function' ? this._os.totalmem() : 0;
      rawFree = typeof this._os.freemem === 'function' ? this._os.freemem() : 0;
    } catch {
      rawTotal = 0;
      rawFree = 0;
    }

    const totalMem = typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 0;
    const freeMem =
      typeof rawFree === 'number' && Number.isFinite(rawFree) && rawFree >= 0
        ? totalMem > 0
          ? Math.min(rawFree, totalMem)
          : rawFree
        : 0;
    const freeMemRatio = totalMem > 0 ? Math.min(1, Math.max(0, freeMem / totalMem)) : 0;

    return {
      standbyReady: normalizedLoad < this.maxCpuLoadThreshold && freeMemRatio > 0.05,
      metrics: {
        cpuCount,
        normalizedLoad: Number(normalizedLoad.toFixed(3)),
        freeMemoryMB: Math.round(freeMem / 1048576)
      }
    };
  }

  executeIsolatedShard(shard) {
    if (!shard || typeof shard !== 'object') {
      throw new TypeError('Invalid shard: must be a non-null object');
    }
    if (shard.shardId !== undefined && typeof shard.shardId !== 'string') {
      throw new TypeError('Invalid shardId: must be a string');
    }

    const validation = this.validateTaskCode(shard.taskCode);
    if (!validation.valid) {
      throw new Error(`Sandbox code validation failed: ${validation.error}`);
    }

    const encodedInput = encodeInputForRealm(shard.inputData);
    const [seed0, seed1, seed2, seed3] = computeDeterministicSeeds(shard.shardId, encodedInput);

    const context = vm.createContext(Object.create(null), {
      name: 'openside-zero-trust-shard',
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: 'afterEvaluate'
    });

    context.__os_encoded_input = encodedInput;
    context.__os_deterministic = this.deterministic;
    context.__os_virtual_now = this.virtualTimestamp;
    context.__os_seed0 = seed0;
    context.__os_seed1 = seed1;
    context.__os_seed2 = seed2;
    context.__os_seed3 = seed3;

    VM_BOOTSTRAP_SCRIPT.runInContext(context, { displayErrors: false });

    const script = new vm.Script(
      `"use strict";\n(function(data) {\n${shard.taskCode}\n})((() => { const v = __os_input; delete globalThis.__os_input; return v; })());`,
      { filename: 'openside-shard.js' }
    );

    const startNs = process.hrtime.bigint();
    let rawOutput;
    try {
      rawOutput = script.runInContext(context, {
        timeout: this.maxExecutionMs,
        breakOnSigint: true,
        displayErrors: false
      });
    } catch (err) {
      throw reconstructHostError(err);
    }

    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const executionTimeMs = Number(elapsedMs.toFixed(4)) || 0.0001;
    const output = reconstructInHostRealm(rawOutput);

    return {
      shardId: shard.shardId,
      output,
      executionTimeMs
    };
  }

  async executeIsolatedShardAsync(shard, options = {}) {
    if (!shard || typeof shard !== 'object') {
      throw new TypeError('Invalid shard: must be a non-null object');
    }
    if (shard.shardId !== undefined && typeof shard.shardId !== 'string') {
      throw new TypeError('Invalid shardId: must be a string');
    }

    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : this.maxExecutionMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Invalid timeoutMs: must be a positive finite number');
    }

    const memoryLimitMb = opts.memoryLimitMb !== undefined ? opts.memoryLimitMb : this.maxMemoryMb;
    if (typeof memoryLimitMb !== 'number' || !Number.isFinite(memoryLimitMb) || memoryLimitMb <= 0) {
      throw new RangeError('Invalid memoryLimitMb: must be a positive finite number');
    }

    const validation = this.validateTaskCode(shard.taskCode);
    if (!validation.valid) {
      throw new Error(`Sandbox code validation failed: ${validation.error}`);
    }

    if (this.workerPool && (opts.memoryLimitMb === undefined || opts.memoryLimitMb === this.maxMemoryMb) && opts.useWorkerPool !== false) {
      return this.workerPool.execute(shard, { ...opts, timeoutMs });
    }

    const encodedInput = encodeInputForRealm(shard.inputData);
    const [seed0, seed1, seed2, seed3] = computeDeterministicSeeds(shard.shardId, encodedInput);

    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_BOOTSTRAP_SCRIPT, {
        eval: true,
        workerData: {
          shardId: shard.shardId,
          taskCode: shard.taskCode,
          encodedInput,
          deterministic: this.deterministic,
          virtualTimestamp: this.virtualTimestamp,
          seed0,
          seed1,
          seed2,
          seed3,
          timeoutMs,
          bootstrapCode: VM_BOOTSTRAP_CODE
        },
        resourceLimits: {
          maxOldGenerationSizeMb: memoryLimitMb,
          maxYoungGenerationSizeMb: Math.max(8, Math.floor(memoryLimitMb / 4))
        }
      });

      let settled = false;
      let pendingMessage = null;
      let execTimer = null;
      let exitFallbackTimer = null;

      const clearAllTimers = () => {
        if (spawnTimer) {
          clearTimeout(spawnTimer);
          spawnTimer = null;
        }
        if (execTimer) {
          clearTimeout(execTimer);
          execTimer = null;
        }
        if (exitFallbackTimer) {
          clearTimeout(exitFallbackTimer);
          exitFallbackTimer = null;
        }
      };

      const settleWithPayload = (msg) => {
        if (!msg || typeof msg !== 'object') {
          reject(new Error('Worker exited without returning a valid result payload'));
          return;
        }
        if (msg.ok) {
          resolve({
            shardId: msg.shardId,
            output: msg.output,
            executionTimeMs: msg.executionTimeMs
          });
        } else {
          reject(buildErrorByName(msg.errorName || 'Error', msg.error || 'Worker execution failed', msg.errorCode));
        }
      };

      const failAndTerminate = (err) => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        this._activeWorkers.delete(worker);
        worker.terminate().catch(() => {}).finally(() => reject(err));
      };

      // Guard against worker creation hang before V8 isolate comes online
      let spawnTimer = setTimeout(() => {
        failAndTerminate(new Error(`Sandbox worker startup timed out before execution (${timeoutMs}ms budget)`));
      }, Math.max(15000, timeoutMs * 4));
      if (typeof spawnTimer.unref === 'function') spawnTimer.unref();

      this._activeWorkers.add(worker);

      worker.on('online', () => {
        if (spawnTimer) {
          clearTimeout(spawnTimer);
          spawnTimer = null;
        }
        if (settled) return;
        execTimer = setTimeout(() => {
          failAndTerminate(new Error(`Sandbox worker execution timed out after ${timeoutMs}ms`));
        }, timeoutMs + 25);
        if (typeof execTimer.unref === 'function') execTimer.unref();
      });

      worker.on('message', (msg) => {
        if (settled) return;
        pendingMessage = msg;
        clearAllTimers();
        // Allow worker to exit naturally with code 0; fallback termination if exit stalls
        exitFallbackTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearAllTimers();
          this._activeWorkers.delete(worker);
          worker.terminate().catch(() => {}).finally(() => settleWithPayload(pendingMessage));
        }, 500);
        if (typeof exitFallbackTimer.unref === 'function') exitFallbackTimer.unref();
      });

      worker.on('messageerror', (err) => {
        failAndTerminate(new Error(`Sandbox worker message serialization failed: ${err.message}`));
      });

      worker.on('error', (err) => {
        const wrapped =
          err instanceof Error
            ? err
            : new Error(`Sandbox worker failed: ${String(err)}`);
        if (err && err.code && !wrapped.code) {
          wrapped.code = err.code;
        }
        failAndTerminate(wrapped);
      });

      worker.on('exit', (exitCode) => {
        this._activeWorkers.delete(worker);
        if (settled) return;
        settled = true;
        clearAllTimers();
        if (pendingMessage !== null) {
          settleWithPayload(pendingMessage);
          return;
        }
        reject(new Error(`Sandbox worker terminated unexpectedly with exit code ${exitCode}`));
      });
    });
  }

  async terminateAllWorkers() {
    const terminations = [];
    if (this.workerPool && typeof this.workerPool.terminateAllWorkers === 'function') {
      terminations.push(this.workerPool.terminateAllWorkers());
    }
    if (this._activeWorkers && this._activeWorkers.size > 0) {
      for (const worker of this._activeWorkers) {
        terminations.push(worker.terminate().catch(() => {}));
      }
      this._activeWorkers.clear();
    }
    await Promise.allSettled(terminations);
  }
}

module.exports = { StandbySandbox, StandbyWorkerPool, normalizeTaskCode, canonicalize };
