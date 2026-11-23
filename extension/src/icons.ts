/**
 * Harbor's icons: Lucide (https://lucide.dev, ISC), bundled as SVG.
 *
 * Use these instead of emoji or text glyphs. Only the icons named here are
 * bundled, so add one to ICONS before using it.
 */
import {
  ArrowLeft, BadgeCheck, BookOpen, Camera, ChevronDown, ChevronRight, Clock,
  FileText, Globe, List, Mail, MessageCircle,
  MousePointerClick, Package, Pencil, Play, Plug, RefreshCw, RotateCw, Server,
  Shield, SlidersHorizontal, Sparkles, Star, Tag, TriangleAlert, Volume2, Wrench, X, Zap,
  type IconNode,
} from 'lucide';

export const ICONS = {
  'arrow-left': ArrowLeft,
  'badge-check': BadgeCheck,
  'book-open': BookOpen,
  camera: Camera,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  clock: Clock,
  'file-text': FileText,
  globe: Globe,
  list: List,
  mail: Mail,
  'message-circle': MessageCircle,
  'mouse-pointer-click': MousePointerClick,
  package: Package,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  'refresh-cw': RefreshCw,
  'rotate-cw': RotateCw,
  server: Server,
  shield: Shield,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  'triangle-alert': TriangleAlert,
  'volume-2': Volume2,
  wrench: Wrench,
  x: X,
  zap: Zap,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * SVG markup for an icon. It's decorative (aria-hidden) unless `label` is
 * given, and draws in currentColor, so it takes the surrounding text color.
 */
export function icon(name: IconName, { size = 16, label }: { size?: number; label?: string } = {}): string {
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true"';
  const body = ICONS[name]
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(String(v))}"`).join(' ')}/>`)
    .join('');
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The same icon built as DOM nodes, for code that must never parse markup
 * (see scope-item.ts). Decorative: aria-hidden.
 */
export function iconElement(name: IconName, { size = 16 }: { size?: number } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    class: 'icon', width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    focusable: 'false', 'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, childAttrs] of ICONS[name]) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(childAttrs)) child.setAttribute(k, String(v));
    svg.appendChild(child);
  }
  return svg;
}

/**
 * Fill every `<i data-icon="name" data-icon-size="16">` under `root` with its
 * SVG. Static HTML uses this so the markup stays readable.
 */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon ?? '';
    if (!isIconName(name)) {
      console.warn(`[Harbor] Unknown icon "${name}"`);
      return;
    }
    const size = Number(el.dataset.iconSize) || 16;
    el.innerHTML = icon(name, { size });
  });
}
