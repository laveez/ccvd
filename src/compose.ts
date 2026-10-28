import type { Browser } from 'playwright-core';
import { blankImage, blit, decodePng, encodePng, type RgbaImage } from './png.ts';

export interface Panel {
  label: string;
  detail: string;
  image: RgbaImage;
  tone?: 'changed' | 'unchanged';
}

interface LabelMetrics {
  font: number;
  height: number;
}

const BACKGROUND = [246, 248, 250, 255] as const;

// Panels are copied pixel for pixel; only the label strips are drawn by the browser, so the images
// in an export are exactly the captured ones and no strip is wider than one panel.
export async function composeImage(browser: Browser, panels: Panel[], scale: 1 | 2): Promise<Buffer> {
  const metrics = labelMetrics(Math.max(...panels.map(panel => panel.image.width)) / scale);
  const gutter = metrics.font * scale;
  const labelHeight = metrics.height * scale;
  const width = panels.reduce((sum, panel) => sum + panel.image.width, 0) + gutter * (panels.length + 1);
  const height = Math.max(...panels.map(panel => panel.image.height)) + labelHeight + gutter * 2;
  const canvas = blankImage(width, height, BACKGROUND);
  const labels = await renderLabels(browser, panels, scale, metrics);
  let left = gutter;
  panels.forEach((panel, index) => {
    blit(canvas, labels[index], left, gutter);
    blit(canvas, panel.image, left, gutter + labelHeight);
    left += panel.image.width + gutter;
  });
  return encodePng(canvas, { level: 6 });
}

// Labels grow with the panels so they stay legible when a PR body scales a wide export down.
function labelMetrics(panelWidth: number): LabelMetrics {
  const font = Math.round(Math.min(64, Math.max(16, panelWidth / 36)));
  return { font, height: Math.round(font * 2.2) };
}

async function renderLabels(
  browser: Browser,
  panels: Panel[],
  scale: 1 | 2,
  metrics: LabelMetrics,
): Promise<RgbaImage[]> {
  const context = await browser.newContext({
    viewport: { width: 400, height: metrics.height },
    deviceScaleFactor: scale,
  });
  try {
    const page = await context.newPage();
    const labels: RgbaImage[] = [];
    for (const panel of panels) {
      const width = Math.round(panel.image.width / scale);
      await page.setViewportSize({ width, height: metrics.height });
      await page.setContent(labelHtml(panel, width, metrics));
      labels.push(decodePng(await page.screenshot({ clip: { x: 0, y: 0, width, height: metrics.height } })));
    }
    return labels;
  } finally {
    await context.close();
  }
}

function labelHtml(panel: Panel, width: number, { font, height }: LabelMetrics): string {
  const color = panel.tone === 'changed' ? '#cf222e' : panel.tone === 'unchanged' ? '#1a7f37' : '#59636e';
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: rgb(${BACKGROUND.slice(0, 3).join(',')}); }
    div { box-sizing: border-box; width: ${width}px; height: ${height}px; padding-bottom: ${Math.round(font * 0.45)}px;
      display: flex; align-items: flex-end; gap: ${Math.round(font * 0.6)}px; white-space: nowrap; overflow: hidden;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    b { font-size: ${font}px; line-height: 1; font-weight: 700; color: #1f2328; }
    span { font-size: ${Math.round(font * 0.75)}px; line-height: 1.1; color: ${color};
      overflow: hidden; text-overflow: ellipsis; }
  </style><div><b>${escapeHtml(panel.label)}</b><span>${escapeHtml(panel.detail)}</span></div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`);
}

export function diffDetail(changed: number, total: number): string {
  if (changed === 0) return 'No changed pixels';
  const share = (changed / total) * 100;
  const percent = share < 0.01 ? '<0.01' : share.toFixed(share < 1 ? 2 : 1);
  return `${changed.toLocaleString('en-US')} px changed (${percent}%)`;
}
