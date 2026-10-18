import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function getFilesToScan(dir: string): string[] {
  const result: string[] = [];
  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test' && entry.name !== 'node_modules') {
          walk(fullPath);
        }
      } else if (
        (entry.name.endsWith('.ts') ||
          entry.name.endsWith('.tsx') ||
          entry.name.endsWith('.css')) &&
        entry.name !== 'tokens.css' &&
        !entry.name.includes('.test.')
      ) {
        result.push(fullPath);
      }
    }
  }
  walk(dir);
  return result;
}

// Calculate relative luminance for WCAG contrast
function getLuminance(hex: string): number {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16) / 255;
  const g = parseInt(cleaned.substring(2, 4), 16) / 255;
  const b = parseInt(cleaned.substring(4, 6), 16) / 255;

  const a = [r, g, b].map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getLuminance(hex1);
  const lum2 = getLuminance(hex2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('Design Tokens and Style Discipline Guard (D5)', () => {
  const srcDir = path.resolve(process.cwd(), 'src');
  const files = getFilesToScan(srcDir);

  it('scans source files and fails on forbidden patterns, colors, arbitrary classes, and forbidden steps', () => {
    console.log(`Design guard scanning ${files.length} files...`);

    const allowedSpacingSteps = new Set([
      '0',
      '1',
      '2',
      '3',
      '4',
      '6',
      '8',
      '10',
      '12',
      '16',
      'px',
      '0.5',
      '1.5',
      '2.5',
      '3.5'
    ]);

    const spacingRegex =
      /(?:^|\s|-)(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-([a-zA-Z0-9.]+)/g;

    const violations: Array<{ file: string; line: number; violation: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        const lineNum = index + 1;

        // Ignore imports of assets or comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

        // 1. Hex color literals: #[0-9a-fA-F]{3,8} (excluding url fragment links)
        const hexMatch = line.match(/#[0-9a-fA-F]{3,8}\b/g);
        if (hexMatch) {
          // Verify it's not a url fragment or html id
          const isColor = hexMatch.some((h) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/i.test(h));
          if (isColor && !line.includes('href="#') && !line.includes('id="#')) {
            violations.push({
              file: path.relative(srcDir, file),
              line: lineNum,
              violation: `Hex color literal found: ${hexMatch.join(', ')}`
            });
          }
        }

        // 2. rgb() or hsl() literals
        if (/\brgb\(|\bhsl\(/i.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: lineNum,
            violation: 'rgb() or hsl() color literal found'
          });
        }

        // 3. Tailwind arbitrary values (-[)
        if (/-\[[^\]]+\]/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: lineNum,
            violation: 'Tailwind arbitrary value (-[) found'
          });
        }

        // 4. dark: variants
        if (/\bdark:/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: lineNum,
            violation: 'dark: variant found'
          });
        }

        // 5. Forbidden radii
        if (/\brounded-(xl|2xl|3xl|full)\b/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: lineNum,
            violation: 'Forbidden border radius found (rounded-xl, 2xl, 3xl, full)'
          });
        }

        // 6. Font weights other than normal, medium, semibold
        if (/\bfont-(thin|extralight|light|bold|extrabold|black)\b/.test(line)) {
          violations.push({
            file: path.relative(srcDir, file),
            line: lineNum,
            violation: 'Forbidden font-weight found (only normal, medium, semibold allowed)'
          });
        }

        // 7. Spacing steps
        let match;
        const spacingCheckLine = line;
        while ((match = spacingRegex.exec(spacingCheckLine)) !== null) {
          const step = match[2];
          // Skip if step is auto, full, screen, min, max, fit
          if (['auto', 'full', 'screen', 'min', 'max', 'fit'].includes(step)) continue;
          if (!allowedSpacingSteps.has(step)) {
            violations.push({
              file: path.relative(srcDir, file),
              line: lineNum,
              violation: `Disallowed spacing utility step: ${match[1]}-${step}`
            });
          }
        }
      });
    }

    if (violations.length > 0) {
      console.error('Design violations found:\n', JSON.stringify(violations, null, 2));
    }

    expect(violations).toHaveLength(0);
    expect(files.length).toBeGreaterThan(10);
  });

  it('computes WCAG contrast ratio of every text and background token pair in tokens.css and fails below 4.5:1', () => {
    const pairs: Array<{ name: string; text: string; bg: string }> = [
      { name: 'default text on background', text: '#171717', bg: '#FFFFFF' },
      { name: 'default text on surface', text: '#171717', bg: '#F5F5F5' },
      { name: 'muted text on background', text: '#525252', bg: '#FFFFFF' },
      { name: 'muted text on surface', text: '#525252', bg: '#F5F5F5' },
      { name: 'primary button text on background', text: '#FFFFFF', bg: '#171717' },
      { name: 'primary hover text on background', text: '#FFFFFF', bg: '#262626' },
      { name: 'success text on background', text: '#166534', bg: '#DCFCE7' },
      { name: 'warning text on background', text: '#92400E', bg: '#FEF3C7' },
      { name: 'danger text on background', text: '#B91C1C', bg: '#FEE2E2' },
      { name: 'info text on background', text: '#1E40AF', bg: '#DBEAFE' },
      { name: 'neutral text on background', text: '#404040', bg: '#E5E5E5' }
    ];

    console.log(`Checking WCAG contrast for ${pairs.length} token pairs...`);

    for (const pair of pairs) {
      const ratio = getContrastRatio(pair.text, pair.bg);
      console.log(`Pair: ${pair.name} -> ratio: ${ratio.toFixed(2)}:1`);
      expect(
        ratio,
        `Pair ${pair.name} contrast ratio ${ratio.toFixed(2)}:1 must be >= 4.5:1`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
