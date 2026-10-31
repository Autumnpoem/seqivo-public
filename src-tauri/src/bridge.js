window.taskboard = {
  request: (method, path, body) => window.__TAURI__.core.invoke('api_request', { method, path, body: body ?? {} }),
  subscribe: callback => {
    let stopped = false; let off;
    window.__TAURI__.event.listen('board-changed', () => callback()).then(fn => { if (stopped) fn(); else off=fn; });
    return () => { stopped=true; off?.(); };
  },
  startupStatus: () => window.__TAURI__.core.invoke('startup_status'),
  subscribeStartup: async callback => window.__TAURI__.event.listen('startup-status', event => callback(event.payload)),
  openFloating: () => window.__TAURI__.core.invoke('open_floating'),
  setFloatingCompact: compact => window.__TAURI__.core.invoke('set_floating_compact', {compact}),
  showMain: () => window.__TAURI__.core.invoke('show_main'),
  chooseDirectory: () => window.__TAURI__.core.invoke('choose_directory')
};
