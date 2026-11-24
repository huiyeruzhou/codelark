import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import { Resvg } from '@resvg/resvg-js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/** Local TeX → self-contained SVG → PNG; no browser or remote renderer. */
export function renderMathSvg(tex: string, display: boolean): { svg: string; width: number; height: number; baseline: number } {
  if (tex.length > 4096) throw new Error('Formula exceeds rendering limit');
  const document = mathjax.document('', {
    InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'boldsymbol'], maxBuffer: 8192,
      formatError: (_jax: unknown, error: Error) => { throw error; } }),
    OutputJax: new SVG({ fontCache: 'none' }),
  });
  const container = document.convert(tex, { display, em: 16, ex: 8, containerWidth: 560 });
  const svg = adaptor.outerHTML(adaptor.firstChild(container) as never);
  const width = Math.ceil(Number(/\bwidth="([\d.]+)ex"/u.exec(svg)?.[1]) * 8);
  const height = Math.ceil(Number(/\bheight="([\d.]+)ex"/u.exec(svg)?.[1]) * 8);
  if (!(width > 0 && height > 0 && width <= 4096 && height <= 2048)) throw new Error('Invalid formula dimensions');
  const sized = svg.replace(/\bwidth="[^"]*"/u, `width="${width}"`)
    .replace(/\bheight="[^"]*"/u, `height="${height}"`);
  const depth = Number(/vertical-align:\s*([-\d.]+)ex/u.exec(svg)?.[1] || 0) * 8;
  return { svg: sized, width, height, baseline: height + depth };
}

export function renderMathPng(tex: string, display: boolean): Buffer {
  const { svg, width, height } = renderMathSvg(tex, display);
  return Buffer.from(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width + 16}" height="${height + 16}">${svg.replace('<svg ', '<svg x="8" y="8" ')}</svg>`, {
    background: '#ffffff', fitTo: { mode: 'zoom', value: 2 },
  }).render().asPng());
}
