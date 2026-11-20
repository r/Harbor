/**
 * Harbor's icons: Lucide (https://lucide.dev, ISC), bundled as SVG.
 *
 * Use these instead of emoji or text glyphs. Only the icons named here are
 * bundled, so add one to ICONS before using it.
 */
import {
  BadgeCheck, BookOpen, Camera, Check, ChevronDown, ChevronRight, Clock,
  FileText, Globe, KeyRound, List, Mail, MessageCircle, Monitor, Moon,
  MousePointerClick, Package, Pencil, Play, Plug, RefreshCw, RotateCw, Server,
  Shield, Sparkles, Star, Sun, Tag, TriangleAlert, Volume2, Wrench, X, Zap,
  type IconNode,
} from 'lucide';

export const ICONS = {
  'badge-check': BadgeCheck,
  'book-open': BookOpen,
  camera: Camera,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  clock: Clock,
  'file-text': FileText,
  globe: Globe,
  'key-round': KeyRound,
  list: List,
  mail: Mail,
  'message-circle': MessageCircle,
  monitor: Monitor,
  moon: Moon,
  'mouse-pointer-click': MousePointerClick,
  package: Package,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  'refresh-cw': RefreshCw,
  'rotate-cw': RotateCw,
  server: Server,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  sun: Sun,
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
