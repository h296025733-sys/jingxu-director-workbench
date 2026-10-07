// Author public, synthetic showroom media. No employee media and no Codex calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EDIT_TEMPLATES, EDIT_TEMPLATE_VERSION, applyEditTemplate } from '../lib/edit-templates.ts';

const root = process.cwd();
const working = path.join(root, '.tmp-edit-previews-20260908');
fs.mkdirSync(working, { recursive: true });
const languages = {
  en: ['See the difference.', 'Focus on what matters.', 'Make every word count.'],
  es: ['Mira la diferencia.', 'Enfócate en lo importante.', 'Haz que cada palabra cuente.'],
};
const clips = [];
for (const template of EDIT_TEMPLATES) for (const [language, phrases] of Object.entries(languages)) {
  const raw = {
    output: { width: 432, height: 768 }, clips: [],
    overlays: phrases.map((text, index) => ({
      kind: template.id === 'clear' ? 'caption' : ['title', 'caption', 'label'][index],
      text, start: 0.35 + index * 3.3, end: 3.2 + index * 3.3,
      preset: 'default', animation: template.id === 'clear' || index === 1 ? 'fade' : index === 0 ? ({focus:'pop',social:'bounce',impact:'punch'}[template.id]) : 'tag',
      effect_reason: ['hook', 'readability', 'cta'][index], highlights: [],
      x: 0.5, y: index === 1 ? 0.70 : 0.40, align: 5,
    })),
  };
  clips.push({ id: template.id, language, ...applyEditTemplate(raw, template.id, EDIT_TEMPLATE_VERSION) });
}
const input = path.join(working, 'preview-input.json');
fs.writeFileSync(input, JSON.stringify({ version: EDIT_TEMPLATE_VERSION, languages, clips }, null, 2));
const python = process.env.DW_EDIT_PREVIEW_PYTHON || path.resolve(process.env.DW_AUTO_EDIT_LAB_ROOT || path.join(root, '..', 'codex-auto-video-lab'), '.venv/Scripts/python.exe');
const result = spawnSync(python, [path.join(root, 'scripts/render-edit-template-previews.py'), input, path.join(root, 'public/edit-previews', `v${EDIT_TEMPLATE_VERSION}`)], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
