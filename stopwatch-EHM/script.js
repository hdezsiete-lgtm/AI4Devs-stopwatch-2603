/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  CHRONO — Premium Timer & Countdown                      ║
 * ║  Módulos: State · Stopwatch · Countdown · UI · Audio     ║
 * ╚══════════════════════════════════════════════════════════╝
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1.  ESTADO GLOBAL
   ═══════════════════════════════════════════════════════════ */
const State = {
  mode:        'stopwatch',  // 'stopwatch' | 'countdown'
  running:     false,
  startTime:   0,            // performance.now() al arrancar
  elapsed:     0,            // ms acumulados (stopwatch)
  countdownMs: 0,            // ms restantes (countdown)
  totalMs:     0,            // ms totales configurados (para el ring)
  rafId:       null,         // requestAnimationFrame handle
  laps:        [],           // array de { n, time, split }
  lastLapMs:   0,            // ms en el último lap
};

/* ═══════════════════════════════════════════════════════════
   2.  REFERENCIAS AL DOM
   ═══════════════════════════════════════════════════════════ */
const Dom = {
  // Display
  hours:       document.getElementById('d-hours'),
  colonH:      document.getElementById('d-colon-h'),
  minutes:     document.getElementById('d-minutes'),
  seconds:     document.getElementById('d-seconds'),
  msDisplay:   document.getElementById('ms-display'),
  mainDisplay: document.getElementById('main-display'),

  // Controles
  btnStart:    document.getElementById('btn-start'),
  btnStartLbl: document.getElementById('btn-start-label'),
  btnReset:    document.getElementById('btn-reset'),
  btnLap:      document.getElementById('btn-lap'),

  // Tabs
  tabSW:       document.getElementById('tab-stopwatch'),
  tabCD:       document.getElementById('tab-countdown'),

  // Countdown config
  cdConfig:    document.getElementById('countdown-config'),
  cfgH:        document.getElementById('cfg-h'),
  cfgM:        document.getElementById('cfg-m'),
  cfgS:        document.getElementById('cfg-s'),

  // Laps
  lapsPanel:   document.getElementById('laps-panel'),
  lapsList:    document.getElementById('laps-list'),

  // Progress ring
  progressSvg:  document.getElementById('progress-svg'),
  progressRing: document.getElementById('progress-ring'),

  // Status badge
  statusBadge:  document.getElementById('status-badge'),
  statusDot:    document.getElementById('status-dot'),
  statusText:   document.getElementById('status-text'),
};

/* ═══════════════════════════════════════════════════════════
   3.  MÓDULO DE AUDIO — Web Audio API (sin archivos externos)
   ═══════════════════════════════════════════════════════════ */
const Audio = (() => {
  let ctx = null;

  /** Crea el AudioContext de forma lazy (requiere interacción del usuario) */
  function _getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  /**
   * Genera un pitido simple
   * @param {number} freq - Frecuencia Hz
   * @param {number} dur  - Duración segundos
   * @param {string} type - Forma de onda
   * @param {number} vol  - Volumen 0–1
   */
  function beep(freq = 880, dur = 0.12, type = 'sine', vol = 0.4) {
    try {
      const a = _getCtx();
      const osc = a.createOscillator();
      const gain = a.createGain();
      osc.connect(gain);
      gain.connect(a.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, a.currentTime);
      gain.gain.setValueAtTime(vol, a.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      osc.start(a.currentTime);
      osc.stop(a.currentTime + dur);
    } catch (_) {}
  }

  /** Doble pitido para "lap" */
  function lapBeep() {
    beep(660, 0.08, 'square', 0.25);
    setTimeout(() => beep(880, 0.08, 'square', 0.25), 100);
  }

  /** Alarma al finalizar cuenta atrás (3 pitidos ascendentes) */
  function alarmBeep() {
    const freqs = [523, 659, 784, 1047];
    freqs.forEach((f, i) => {
      setTimeout(() => beep(f, 0.18, 'sine', 0.5), i * 160);
    });
  }

  return { beep, lapBeep, alarmBeep };
})();

/* ═══════════════════════════════════════════════════════════
   4.  UTILIDADES DE FORMATO
   ═══════════════════════════════════════════════════════════ */
/**
 * Convierte milisegundos a objeto con horas/min/seg/ms
 * @param {number} ms
 * @returns {{ h, m, s, ms }}
 */
function msToTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  return {
    h:  Math.floor(totalSec / 3600),
    m:  Math.floor((totalSec % 3600) / 60),
    s:  totalSec % 60,
    ms: Math.floor((ms % 1000) / 10),  // centésimas
  };
}

/** Padding de 2 dígitos */
const pad2 = n => String(n).padStart(2, '0');

/**
 * Formatea ms como string HH:MM:SS o MM:SS
 * @param {number} ms
 * @param {boolean} forceHours
 */
function formatTime(ms, forceHours = false) {
  const t = msToTime(ms);
  if (t.h > 0 || forceHours) {
    return `${pad2(t.h)}:${pad2(t.m)}:${pad2(t.s)}`;
  }
  return `${pad2(t.m)}:${pad2(t.s)}`;
}

/* ═══════════════════════════════════════════════════════════
   5.  MÓDULO UI — Actualiza el DOM
   ═══════════════════════════════════════════════════════════ */
const UI = (() => {

  /** Actualiza el display LED principal */
  function updateDisplay(ms, showMs = true) {
    const t = msToTime(ms);
    const hasHours = t.h > 0;

    // Horas (ocultar si son 0)
    Dom.hours.textContent  = pad2(t.h);
    Dom.colonH.classList.toggle('hidden', !hasHours);
    Dom.hours.classList.toggle('hidden', !hasHours);

    Dom.minutes.textContent = pad2(t.m);
    Dom.seconds.textContent = pad2(t.s);

    // Centésimas (solo stopwatch)
    Dom.msDisplay.textContent = showMs ? `.${pad2(t.ms)}` : '';
    Dom.msDisplay.style.opacity = showMs ? '1' : '0';
  }

  /** Actualiza el arco SVG del countdown */
  function updateRing(remaining, total) {
    if (total === 0) return;
    const circumference = 791.7; // 2π × 126
    const progress = Math.min(remaining / total, 1);
    const offset   = circumference * (1 - progress);
    Dom.progressRing.style.strokeDashoffset = offset;

    // Color: verde→cyan→ámbar→rojo según tiempo restante
    const pct = progress;
    let stroke = '#00f5ff'; // cyan
    if (pct < 0.5) stroke = '#ffb800'; // ámbar
    if (pct < 0.2) stroke = '#ff2d55'; // rojo
    Dom.progressRing.style.stroke = stroke;
  }

  /** Actualiza el badge de estado */
  function setStatus(state) {
    const map = {
      ready:   { text: 'Listo',     dot: 'bg-slate-600',   border: 'border-slate-700',  color: 'text-slate-500'  },
      running: { text: 'Activo',    dot: 'bg-neon-green',  border: 'border-green-800',  color: 'text-green-400'  },
      paused:  { text: 'Pausado',   dot: 'bg-neon-amber',  border: 'border-yellow-800', color: 'text-yellow-400' },
      done:    { text: 'Completado',dot: 'bg-neon-red',    border: 'border-red-800',    color: 'text-red-400'    },
    };
    const cfg = map[state] || map.ready;
    Dom.statusDot.className  = `w-1.5 h-1.5 rounded-full transition-colors duration-300 ${cfg.dot}`;
    Dom.statusBadge.className = `flex items-center gap-2 px-3 py-1.5 rounded-full border text-[10px] font-ui tracking-widest uppercase transition-all duration-300 ${cfg.border} ${cfg.color}`;
    Dom.statusText.textContent = cfg.text;
  }

  /** Muestra/oculta el ring SVG */
  function toggleRing(show) {
    Dom.progressSvg.style.opacity = show ? '1' : '0';
  }

  /** Flash de alerta al finalizar */
  function flashAlert() {
    const overlay = document.createElement('div');
    overlay.className = 'alert-flash';
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1400);
  }

  /** Ripple en botones */
  function addRipple(btn, e) {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top  - size / 2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  }

  /** Añade una fila de lap a la lista */
  function appendLap(lapData) {
    const { n, absolute, split } = lapData;
    const row = document.createElement('div');
    row.className = 'lap-row flex justify-between items-center py-3 text-sm';
    row.innerHTML = `
      <span class="text-slate-600 font-ui text-xs tracking-widest uppercase">Vuelta ${String(n).padStart(2,'0')}</span>
      <span class="font-display text-xs text-neon-cyan tracking-wider">${absolute}</span>
      <span class="font-display text-xs text-slate-500 tracking-wider">+${split}</span>
    `;
    Dom.lapsList.prepend(row);
    Dom.lapsPanel.classList.remove('hidden');
  }

  return { updateDisplay, updateRing, setStatus, toggleRing, flashAlert, addRipple, appendLap };
})();

/* ═══════════════════════════════════════════════════════════
   6.  MÓDULO STOPWATCH
   ═══════════════════════════════════════════════════════════ */
const Stopwatch = (() => {

  /** Loop de animación */
  function _tick() {
    if (!State.running) return;
    const now     = performance.now();
    const elapsed = State.elapsed + (now - State.startTime);

    UI.updateDisplay(elapsed, true);
    State.rafId = requestAnimationFrame(_tick);
  }

  function start() {
    State.startTime = performance.now();
    State.running   = true;
    Dom.btnStartLbl.textContent = 'Pausar';
    Dom.btnStart.classList.replace('bg-neon-cyan', 'bg-neon-amber');
    Dom.btnStart.style.boxShadow = '0 0 20px #ffb80055, 0 0 60px #ffb80022';
    Dom.btnStart.style.color = '#0b0b12';
    UI.setStatus('running');
    _tick();
  }

  function pause() {
    const now = performance.now();
    State.elapsed += now - State.startTime;
    State.running  = false;
    cancelAnimationFrame(State.rafId);
    Dom.btnStartLbl.textContent = 'Continuar';
    Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
    Dom.btnStart.style.boxShadow = '';
    UI.setStatus('paused');
  }

  function reset() {
    State.running  = false;
    State.elapsed  = 0;
    State.lastLapMs = 0;
    cancelAnimationFrame(State.rafId);
    UI.updateDisplay(0, true);
    Dom.btnStartLbl.textContent = 'Iniciar';
    Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
    Dom.btnStart.style.boxShadow = '';
    Dom.btnStart.style.color = '';
    UI.setStatus('ready');
  }

  function lap() {
    if (!State.running) return;
    const elapsed = State.elapsed + (performance.now() - State.startTime);
    const split   = elapsed - State.lastLapMs;
    State.lastLapMs = elapsed;
    State.laps.push({ n: State.laps.length + 1, elapsed, split });
    UI.appendLap({
      n:        State.laps.length,
      absolute: formatTime(elapsed),
      split:    formatTime(split),
    });
    Audio.lapBeep();
  }

  return { start, pause, reset, lap };
})();

/* ═══════════════════════════════════════════════════════════
   7.  MÓDULO COUNTDOWN
   ═══════════════════════════════════════════════════════════ */
const Countdown = (() => {

  /** Obtiene los ms configurados por el usuario */
  function _getConfigMs() {
    const h = parseInt(Dom.cfgH.value) || 0;
    const m = parseInt(Dom.cfgM.value) || 0;
    const s = parseInt(Dom.cfgS.value) || 0;
    return (h * 3600 + m * 60 + s) * 1000;
  }

  /** Loop de animación */
  function _tick() {
    if (!State.running) return;
    const now     = performance.now();
    const elapsed = now - State.startTime;
    let remaining = Math.max(0, State.countdownMs - elapsed);

    UI.updateDisplay(remaining, false);
    UI.updateRing(remaining, State.totalMs);

    // Últimos 10 segundos: clase critica
    const isCritical = remaining <= 10000 && remaining > 0;
    Dom.mainDisplay.classList.toggle('critical', isCritical);

    if (remaining <= 0) {
      _finish();
      return;
    }

    State.rafId = requestAnimationFrame(_tick);
  }

  function _finish() {
    State.running = false;
    State.countdownMs = 0;
    cancelAnimationFrame(State.rafId);
    Dom.mainDisplay.classList.remove('critical');
    Dom.btnStartLbl.textContent = 'Iniciar';
    Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
    Dom.btnStart.style.boxShadow = '';
    Dom.btnStart.style.color = '';
    UI.updateDisplay(0, false);
    UI.updateRing(0, State.totalMs);
    UI.setStatus('done');
    UI.flashAlert();
    Audio.alarmBeep();
    _vibrate();
  }

  /** Vibración en móviles */
  function _vibrate() {
    if ('vibrate' in navigator) {
      navigator.vibrate([300, 100, 300, 100, 300]);
    }
  }

  function start() {
    // Si no hay tiempo restante, tomar de la config
    if (State.countdownMs <= 0) {
      const ms = _getConfigMs();
      if (ms === 0) return; // nada configurado
      State.countdownMs = ms;
      State.totalMs     = ms;
    }
    State.startTime = performance.now();
    State.running   = true;
    Dom.btnStartLbl.textContent = 'Pausar';
    Dom.btnStart.classList.replace('bg-neon-cyan', 'bg-neon-amber');
    Dom.btnStart.style.boxShadow = '0 0 20px #ffb80055, 0 0 60px #ffb80022';
    Dom.btnStart.style.color = '#0b0b12';
    UI.setStatus('running');
    _tick();
  }

  function pause() {
    const now = performance.now();
    State.countdownMs -= now - State.startTime;
    State.running = false;
    cancelAnimationFrame(State.rafId);
    Dom.mainDisplay.classList.remove('critical');
    Dom.btnStartLbl.textContent = 'Continuar';
    Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
    Dom.btnStart.style.boxShadow = '';
    UI.setStatus('paused');
  }

  function reset() {
    State.running     = false;
    State.countdownMs = 0;
    cancelAnimationFrame(State.rafId);
    Dom.mainDisplay.classList.remove('critical');

    // Restaurar display con el tiempo configurado
    const ms = _getConfigMs();
    State.totalMs = ms;
    UI.updateDisplay(ms, false);
    UI.updateRing(ms, ms);
    Dom.btnStartLbl.textContent = 'Iniciar';
    Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
    Dom.btnStart.style.boxShadow = '';
    Dom.btnStart.style.color = '';
    UI.setStatus('ready');
  }

  /** Actualiza preview del display al cambiar inputs */
  function previewFromConfig() {
    if (!State.running && State.countdownMs === 0) {
      const ms = _getConfigMs();
      State.totalMs = ms;
      UI.updateDisplay(ms, false);
      UI.updateRing(ms, ms);
    }
  }

  return { start, pause, reset, previewFromConfig };
})();

/* ═══════════════════════════════════════════════════════════
   8.  CONTROLADORES GLOBALES (llamados desde el HTML)
   ═══════════════════════════════════════════════════════════ */

/**
 * Alterna entre Start y Pause según el estado actual
 */
function toggleStartPause() {
  if (State.running) {
    State.mode === 'stopwatch' ? Stopwatch.pause() : Countdown.pause();
  } else {
    State.mode === 'stopwatch' ? Stopwatch.start() : Countdown.start();
  }
}

/**
 * Resetea el temporizador activo
 */
function resetTimer() {
  if (State.mode === 'stopwatch') {
    Stopwatch.reset();
  } else {
    Countdown.reset();
  }
}

/**
 * Registra una vuelta (solo en modo cronómetro)
 */
function addLap() {
  if (State.mode !== 'stopwatch') return;
  Stopwatch.lap();
}

/**
 * Limpia la lista de vueltas
 */
function clearLaps() {
  State.laps    = [];
  State.lastLapMs = 0;
  Dom.lapsList.innerHTML = '';
  Dom.lapsPanel.classList.add('hidden');
}

/**
 * Cambia entre modos cronómetro / cuenta atrás
 * @param {'stopwatch'|'countdown'} mode
 */
function switchMode(mode) {
  if (mode === State.mode) return;

  // Detener lo que esté corriendo
  if (State.running) resetTimer();

  State.mode = mode;
  const isSW = mode === 'stopwatch';

  // Tabs
  Dom.tabSW.classList.toggle('active', isSW);
  Dom.tabSW.classList.toggle('text-slate-500', !isSW);
  Dom.tabCD.classList.toggle('active', !isSW);
  Dom.tabCD.classList.toggle('text-slate-500', isSW);

  // Config panel y ring
  Dom.cdConfig.classList.toggle('hidden', isSW);
  UI.toggleRing(!isSW);

  // Milisegundos visibles solo en SW
  Dom.msDisplay.style.opacity = isSW ? '1' : '0';

  // Botón lap: visible solo en SW
  Dom.btnLap.style.opacity  = isSW ? '1' : '0';
  Dom.btnLap.style.pointerEvents = isSW ? 'auto' : 'none';

  // Laps panel
  Dom.lapsPanel.classList.add('hidden');

  // Resetear estado
  if (isSW) {
    State.elapsed   = 0;
    UI.updateDisplay(0, true);
    UI.setStatus('ready');
  } else {
    State.countdownMs = 0;
    Countdown.previewFromConfig();
    UI.setStatus('ready');
  }

  Dom.btnStartLbl.textContent = 'Iniciar';
  Dom.btnStart.classList.replace('bg-neon-amber', 'bg-neon-cyan');
  Dom.btnStart.style.boxShadow = '';
  Dom.btnStart.style.color = '';
}

/**
 * Incrementa/decrementa un input numérico con wrapping
 * @param {string} id - ID del input
 * @param {number} delta - +1 o -1
 */
function incrementInput(id, delta) {
  const el  = document.getElementById(id);
  const max = parseInt(el.max);
  let   val = parseInt(el.value) + delta;
  if (val < 0)    val = max;
  if (val > max)  val = 0;
  el.value = val;
  Countdown.previewFromConfig();
}

/**
 * Aplica un preset de tiempo al countdown
 * @param {number} h @param {number} m @param {number} s
 */
function setPreset(h, m, s) {
  Dom.cfgH.value = h;
  Dom.cfgM.value = m;
  Dom.cfgS.value = s;
  if (!State.running) {
    State.countdownMs = 0; // forzar recarga desde config
    Countdown.previewFromConfig();
  }
}

/* ═══════════════════════════════════════════════════════════
   9.  EVENTOS
   ═══════════════════════════════════════════════════════════ */

// Ripple en botones de acción
document.querySelectorAll('.btn-action').forEach(btn => {
  btn.addEventListener('click', e => UI.addRipple(btn, e));
});

// Actualizar preview al cambiar inputs manualmente
[Dom.cfgH, Dom.cfgM, Dom.cfgS].forEach(el => {
  el.addEventListener('input', () => {
    // Clamp
    let v = parseInt(el.value) || 0;
    const max = parseInt(el.max);
    if (v < 0)   v = 0;
    if (v > max) v = max;
    el.value = v;
    State.countdownMs = 0;
    Countdown.previewFromConfig();
  });
});

// Atajos de teclado
document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  switch (e.code) {
    case 'Space':       e.preventDefault(); toggleStartPause(); break;
    case 'KeyR':        e.preventDefault(); resetTimer();       break;
    case 'KeyL':        e.preventDefault(); addLap();           break;
    case 'Digit1':      switchMode('stopwatch'); break;
    case 'Digit2':      switchMode('countdown'); break;
  }
});

/* ═══════════════════════════════════════════════════════════
   10. INICIALIZACIÓN
   ═══════════════════════════════════════════════════════════ */
(function init() {
  UI.updateDisplay(0, true);
  UI.setStatus('ready');

  // Tooltip de teclado (sutil, solo desktop)
  const isTouch = matchMedia('(hover: none)').matches;
  if (!isTouch) {
    const tip = document.createElement('p');
    tip.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-slate-700 font-ui tracking-widest uppercase z-10';
    tip.textContent = 'Espacio: Play/Pause · R: Reset · L: Lap · 1/2: Modos';
    document.body.appendChild(tip);
  }
})();