/**
 * @file Terminal design system: one palette, a handful of primitives.
 *
 * The goal is a calm, Apple-like feel: generous whitespace, one accent colour,
 * rounded panels and right-aligned labels. Every command renders through
 * these helpers so the CLI looks the same everywhere. Respects `NO_COLOR`.
 */
import chalk from 'chalk';

export const color = {
  brand: chalk.hex('#8AB4FF'),
  accent: chalk.hex('#C4A7FF'),
  ok: chalk.hex('#5EE6A8'),
  warn: chalk.hex('#FFC861'),
  err: chalk.hex('#FF7A7A'),
  muted: chalk.hex('#8B93A7'),
  bold: chalk.bold,
};

export const icon = { ok: '✓', warn: '!', err: '✕', dot: '•', arrow: '›', spark: '✦' };

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** @param {string} s */
const visibleWidth = (s) => [...s.replace(ANSI_RE, '')].length;

/** @param {string} s @param {number} width */
const padEnd = (s, width) => s + ' '.repeat(Math.max(0, width - visibleWidth(s)));

/** Print the Study-Ops wordmark. */
export function banner(subtitle = 'UK Edition · Phase 1') {
  console.log();
  console.log(`  ${color.brand.bold('study')}${color.accent.bold('·ops')}  ${color.muted(subtitle)}`);
  console.log(`  ${color.muted('local-first agents for the study-abroad pipeline')}`);
  console.log();
}

/**
 * Render a rounded panel.
 * @param {string} title
 * @param {string[]} lines
 * @param {{ tint?: (s: string) => string }} [opts]
 */
export function panel(title, lines, { tint = color.muted } = {}) {
  const inner = Math.max(visibleWidth(title) + 4, ...lines.map(visibleWidth)) + 2;
  const rule = '─'.repeat(inner - visibleWidth(title) - 3);
  console.log('  ' + tint('╭─ ') + color.bold(title) + tint(` ${rule}╮`));
  for (const line of lines) console.log('  ' + tint('│') + ' ' + padEnd(line, inner - 1) + tint('│'));
  console.log('  ' + tint(`╰${'─'.repeat(inner)}╯`));
  console.log();
}

/**
 * Format an aligned key/value row.
 * @param {string} label
 * @param {string} value
 * @param {number} [width]
 */
export function row(label, value, width = 22) {
  return `${color.muted(label.padStart(width))}  ${value}`;
}

/** @param {string} text */
export const heading = (text) => console.log(`  ${color.accent(icon.spark)} ${color.bold(text)}\n`);
/** @param {string} text */
export const success = (text) => console.log(`  ${color.ok(icon.ok)} ${text}`);
/** @param {string} text */
export const warn = (text) => console.log(`  ${color.warn(icon.warn)} ${text}`);
/** @param {string} text */
export const fail = (text) => console.error(`  ${color.err(icon.err)} ${text}`);
/** @param {string} text */
export const note = (text) => console.log(`  ${color.muted(text)}`);

/**
 * Format a GBP amount.
 * @param {number} amount
 */
export const gbp = (amount) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(amount);
