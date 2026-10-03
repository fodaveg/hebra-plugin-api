/**
 * Plantilla mínima de un plugin de Hebra (`docs/SPEC-PLUGINS-EXTERNOS.md` §3 y §5).
 * Registra un comando, una pieza de la barra de estado, una vista del inspector, una
 * extensión de editor con el CodeMirror PRESTADO por Hebra (§6) y un bloque de código.
 * Se compila a un solo `hebra-main.mjs` con `hebraShared()` (ver el README del paquete).
 *
 * El test de Hebra `src/lib/plugins/api/plugin-template.test.ts` la compila contra el
 * paquete y la activa con la fábrica real (`pluginRuntimeExport`).
 */
import { StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isPluginApiError, type HebraPluginApi, type PluginCleanup } from 'hebra-plugin-api';

interface TemplateSettings {
  greeting: string;
}

const DEFAULT_SETTINGS: TemplateSettings = { greeting: 'Hola desde la plantilla.' };

/** Cuenta los cambios del documento: lo mínimo para comprobar que el `StateField` es del
 *  `@codemirror/state` de Hebra (con otra copia, Hebra rechaza la extensión). */
const editsCounter = StateField.define<number>({
  create: () => 0,
  update: (value, transaction) => (transaction.docChanged ? value + 1 : value)
});

export async function activate(api: HebraPluginApi): Promise<PluginCleanup> {
  const stored = await api.storage.settings.load<Partial<TemplateSettings>>();
  const settings: TemplateSettings = { ...DEFAULT_SETTINGS, ...stored };

  api.ui.registerCommand({
    id: 'plantilla-saludar',
    name: 'Plantilla: saludar',
    run: () => api.ui.notice(settings.greeting)
  });

  const status = api.ui.registerStatusBarItem({
    id: 'plantilla-estado',
    text: 'Plantilla',
    tooltip: 'Plugin de plantilla'
  });

  api.ui.registerView({
    id: 'plantilla-vista',
    title: 'Plantilla',
    icon: 'puzzle',
    mount(el) {
      const paragraph = document.createElement('p');
      paragraph.textContent = settings.greeting;
      el.append(paragraph);
    },
    unmount() {}
  });

  if (api.has('editor')) {
    api.editor.registerExtension([editsCounter, EditorView.lineWrapping]);
    api.editor.registerCodeBlock('plantilla', (el, source) => {
      el.textContent = `Plantilla: ${source.trim()}`;
    });
  }

  if (api.has('vault.read')) {
    const off = api.vault.onChange(() => status.update({ text: 'Plantilla (cambios)' }));
    return () => off();
  }

  // Sin `vault.read` declarada, leer la biblioteca rechaza con un código que se reconoce.
  try {
    api.vault.libraryId();
  } catch (error) {
    if (!isPluginApiError(error, 'capability-not-declared')) throw error;
  }
  return () => {};
}
