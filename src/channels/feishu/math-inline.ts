// Only notation that Unicode can preserve. Unsupported TeX keeps the image renderer.
const symbols: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥',
  ne: '≠', neq: '≠', approx: '≈', equiv: '≡', propto: '∝', infty: '∞', partial: '∂', nabla: '∇',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
};
const superscripts = new Map(Array.from('0123456789+-=()ni', (char, i) => [char, Array.from('⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ')[i]]));
const subscripts = new Map(Array.from('0123456789+-=()aehijklmnoprstuvx', (char, i) => [char, Array.from('₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')[i]]));

/** A deliberately small TeX subset, returned as escaped Markdown text or null. */
export function inlineMathMarkdown(tex: string): string | null {
  if (!tex || tex.length > 4096) return null;
  let result = '';
  let hasBase = false;
  let scripts = '';
  for (let i = 0; i < tex.length;) {
    const char = tex[i++];
    if (/\s/u.test(char)) { result += ' '; continue; }
    if (char === '^' || char === '_') {
      if (!hasBase || scripts.includes(char)) return null;
      scripts += char;
      result = result.trimEnd();
      while (/\s/u.test(tex[i] || '') && i < tex.length) i++;
      let argument: string;
      if (tex[i] === '{') {
        const end = tex.indexOf('}', i + 1);
        if (end < 0) return null;
        argument = tex.slice(i + 1, end).replace(/\s/gu, '');
        i = end + 1;
      } else argument = tex[i++] || '';
      const mapping = char === '^' ? superscripts : subscripts;
      if (!argument || [...argument].some(token => !mapping.has(token))) return null;
      result += [...argument].map(token => mapping.get(token)).join('');
      continue;
    }
    scripts = '';
    if (char === '\\') {
      const command = /^[a-zA-Z]+/u.exec(tex.slice(i))?.[0];
      if (!command || !Object.hasOwn(symbols, command)) return null;
      result += symbols[command];
      hasBase = /^[\p{L}\p{N}∞∂∇]$/u.test(symbols[command]);
      i += command.length;
    } else {
      // Braces outside script arguments, styling, macros and layout need TeX rendering.
      if (!/^[\p{L}\p{N}+\-=<>()[\]|.,:;!/*'−×÷±≤≥≠≈∞]$/u.test(char)) return null;
      result += char;
      hasBase = /^[\p{L}\p{N})\]∞]$/u.test(char);
    }
  }
  // Card Markdown documents HTML entities for literal punctuation, including table pipes.
  return result.replace(/[\\`*_{}[\]()#+.!|<>:-]/gu, char => `&#${char.charCodeAt(0)};`);
}
