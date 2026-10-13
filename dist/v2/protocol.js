/** Los temas que el marco pide con `events.subscribe` (los demás llegan siempre). */
export const PLUGIN_FRAME_SUBSCRIBABLE_TOPICS = [
    'workspace.folders',
    'workspace.notes',
    'workspace.noteTitleRenamed',
    'vault.change',
    'storage.settings'
];
/**
 * Capacidades y funciones del anfitrión que el marco todavía NO da. `has()` las da por `false`
 * aunque estén declaradas, para no prometer lo que el marco no sirve. L5 quitó `notify.sound` y
 * `ui.view.main` (vistas `main`, sonido) y L6 quitó `editor`. Solo queda `ui.view.tab`: las vistas
 * de pestaña no entraron en L5.
 */
export const PLUGIN_FRAME_NOT_YET_SERVED = ['ui.view.tab'];
