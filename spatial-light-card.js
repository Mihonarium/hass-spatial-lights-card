class SpatialLightColorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    
    // State
    this._config = {};
    this._hass = null;
    this._selectedLights = new Set();
    this._hoveredLight = null;
    this._dragState = null;
    this._selectionBox = null;
    this._selectionStart = null;
    this._settingsOpen = false;
    this._yamlModalOpen = false;
    this._history = [];
    this._historyIndex = -1;
    this._longPressTimer = null;
    this._longPressTriggered = false;
    this._boundCloseSettings = null;
    this._documentListenersAttached = false;
    
    // Settings
    this._gridSize = 25;
    this._snapOnModifier = true;
    this._lockPositions = true; // DEFAULT TO LOCKED
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities)) {
      throw new Error('You must specify entities as an array');
    }

    this._config = {
      entities: config.entities,
      positions: config.positions || {},
      title: config.title || 'Lights',
      canvas_height: config.canvas_height || 450,
      grid_size: config.grid_size || 25,
      label_mode: config.label_mode || 'smart',
      label_overrides: config.label_overrides || {},
      show_settings_button: config.show_settings_button !== false, // Default true
      always_show_controls: config.always_show_controls || false, // Default false
      default_entity: config.default_entity || null, // Default none
      controls_below: config.controls_below !== false // Default true (below canvas)
    };

    this._gridSize = this._config.grid_size;
    
    // Auto-layout for unpositioned lights
    this._initializePositions();
    
    // Don't render yet - wait for hass
  }

  set hass(hass) {
    const firstTime = !this._hass;
    this._hass = hass;
    
    // Render on first hass assignment
    if (firstTime) {
      this.render();
    } else {
      this.updateLights();
    }
  }

  /**
   * SMART LABEL GENERATION
   */
  _generateLabel(entity_id) {
    if (this._config.label_overrides[entity_id]) {
      return this._config.label_overrides[entity_id];
    }

    const state = this._hass?.states[entity_id];
    if (!state) return '?';

    const name = state.attributes.friendly_name || entity_id;
    
    // Get all names for context
    const allNames = this._config.entities.map(e => 
      this._hass?.states[e]?.attributes.friendly_name || e
    );

    // Strategy 1: Look for trailing numbers
    const numberMatch = name.match(/(\d+)$/);
    if (numberMatch) {
      const baseName = name.substring(0, name.length - numberMatch[0].length).trim();
      const number = numberMatch[0];
      const similarCount = allNames.filter(n => n.startsWith(baseName)).length;
      
      if (similarCount > 1) {
        const initials = this._getInitials(baseName);
        return initials + number;
      }
    }

    // Strategy 2: Look for directional words
    const words = name.split(/\s+/);
    const directions = ['left', 'right', 'center', 'front', 'back', 'top', 'bottom'];
    const dirWord = words.find(w => directions.includes(w.toLowerCase()));
    
    if (dirWord) {
      const baseWords = words.filter(w => w !== dirWord);
      const initials = baseWords.slice(0, 2).map(w => w[0]).join('');
      return initials.toUpperCase() + dirWord[0].toUpperCase();
    }

    // Strategy 3: Smart abbreviation
    return this._getInitials(name);
  }

  _getInitials(text) {
    const stopWords = ['the', 'a', 'an', 'light', 'lamp', 'bulb'];
    const words = text.split(/\s+/)
      .filter(w => w.length > 0 && !stopWords.includes(w.toLowerCase()));

    if (words.length === 0) return text.substring(0, 2).toUpperCase();
    if (words.length === 1) return words[0].substring(0, 2).toUpperCase();

    return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
  }

  _resolveIcon(state) {
    if (!state) return 'mdi:help-circle-outline';
    if (state.attributes?.icon) return state.attributes.icon;

    const entityId = state.entity_id || '';
    const domain = entityId.split('.')[0];

    if (domain === 'light') {
      return state.state === 'on' ? 'mdi:lightbulb-on' : 'mdi:lightbulb';
    }

    if (domain === 'switch') {
      return state.state === 'on' ? 'mdi:toggle-switch' : 'mdi:toggle-switch-off-outline';
    }

    return 'mdi:help-circle-outline';
  }

  _computeBrightness(state) {
    if (!state || state.state !== 'on') return 0;
    if (typeof state.attributes?.brightness === 'number') {
      return Math.min(1, Math.max(0, state.attributes.brightness / 255));
    }
    return 1;
  }

  _computeLightColors(state) {
    const offColor = {
      base: 'rgba(46, 49, 56, 0.95)',
      glow: 'rgba(16, 18, 22, 0.6)'
    };

    if (!state || state.state !== 'on') {
      return offColor;
    }

    if (Array.isArray(state.attributes?.rgb_color)) {
      const [r, g, b] = state.attributes.rgb_color;
      return {
        base: `rgb(${r}, ${g}, ${b})`,
        glow: `rgba(${r}, ${g}, ${b}, 0.55)`
      };
    }

    if (typeof state.attributes?.color_temp === 'number') {
      const kelvin = Math.round(1000000 / state.attributes.color_temp);
      const rgb = this._kelvinToRGB(kelvin);
      return {
        base: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
        glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`
      };
    }

    if (Array.isArray(state.attributes?.hs_color)) {
      const [h, s] = state.attributes.hs_color;
      const rgb = this._hsToRgb(h, s);
      return {
        base: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
        glow: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`
      };
    }

    return {
      base: '#ffb74d',
      glow: 'rgba(255, 183, 77, 0.55)'
    };
  }

  _hsToRgb(h, s) {
    const hue = (h % 360) / 360;
    const sat = Math.min(1, Math.max(0, s / 100));
    const i = Math.floor(hue * 6);
    const f = hue * 6 - i;
    const p = 1 * (1 - sat);
    const q = 1 * (1 - f * sat);
    const t = 1 * (1 - (1 - f) * sat);
    const mod = i % 6;
    const rgb = [
      [1, t, p],
      [q, 1, p],
      [p, 1, t],
      [p, q, 1],
      [t, p, 1],
      [1, p, q]
    ][mod];

    return {
      r: Math.round(rgb[0] * 255),
      g: Math.round(rgb[1] * 255),
      b: Math.round(rgb[2] * 255)
    };
  }

  _colorTemperatureToCss(temperature) {
    if (!temperature) return '#fbc16d';
    const kelvin = Math.min(9000, Math.max(1000, temperature));
    const rgb = this._kelvinToRGB(kelvin);
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  _kelvinToRGB(kelvin) {
    const temp = kelvin / 100;
    let red;
    let green;
    let blue;

    if (temp <= 66) {
      red = 255;
      green = temp;
      green = 99.4708025861 * Math.log(green) - 161.1195681661;
      blue = temp <= 19 ? 0 : temp - 10;
      blue = 138.5177312231 * Math.log(blue) - 305.0447927307;
    } else {
      red = temp - 60;
      red = 329.698727446 * Math.pow(red, -0.1332047592);
      green = temp - 60;
      green = 288.1221695283 * Math.pow(green, -0.0755148492);
      blue = 255;
    }

    const clamp = (value) => {
      if (Number.isNaN(value)) return 0;
      return Math.min(255, Math.max(0, value));
    };

    return {
      r: Math.round(clamp(red)),
      g: Math.round(clamp(green)),
      b: Math.round(clamp(blue))
    };
  }

  /**
   * AUTO-LAYOUT
   */
  _initializePositions() {
    const unpositioned = this._config.entities.filter(e => !this._config.positions[e]);
    if (unpositioned.length === 0) return;

    const cols = Math.ceil(Math.sqrt(unpositioned.length * 1.5));
    const rows = Math.ceil(unpositioned.length / cols);
    const spacing = 100 / (cols + 1);
    
    unpositioned.forEach((entity, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      
      this._config.positions[entity] = {
        x: spacing * (col + 1),
        y: (100 / (rows + 1)) * (row + 1)
      };
    });
  }

  /**
   * HISTORY
   */
  _saveHistory() {
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(JSON.parse(JSON.stringify(this._config.positions)));
    if (this._history.length > 50) this._history.shift();
    else this._historyIndex++;
  }

  _undo() {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._config.positions = JSON.parse(JSON.stringify(this._history[this._historyIndex]));
      this.render();
    }
  }

  _redo() {
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._config.positions = JSON.parse(JSON.stringify(this._history[this._historyIndex]));
      this.render();
    }
  }

  /**
   * GRID SNAPPING
   */
  _shouldSnap(event) {
    return event?.altKey || !this._snapOnModifier;
  }

  _snapToGrid(x, y, event) {
    if (!this._shouldSnap(event)) return { x, y };
    
    const canvas = this.shadowRoot.getElementById('canvas');
    if (!canvas) return { x, y };
    
    const rect = canvas.getBoundingClientRect();
    const pixelX = (x / 100) * rect.width;
    const pixelY = (y / 100) * rect.height;
    
    const snappedX = Math.round(pixelX / this._gridSize) * this._gridSize;
    const snappedY = Math.round(pixelY / this._gridSize) * this._gridSize;
    
    return {
      x: (snappedX / rect.width) * 100,
      y: (snappedY / rect.height) * 100
    };
  }

  /**
   * GET CURRENT VALUES FROM SELECTED LIGHTS
   */
  _getAverageState() {
    const controlledEntities = this._selectedLights.size > 0 
      ? Array.from(this._selectedLights)
      : (this._config.default_entity ? [this._config.default_entity] : []);
    
    if (controlledEntities.length === 0) {
      return { brightness: 128, temperature: 3500, color: null };
    }

    let totalBrightness = 0;
    let totalTemp = 0;
    let brightCount = 0;
    let tempCount = 0;
    let lastColor = null;

    controlledEntities.forEach(entity_id => {
      const state = this._hass?.states[entity_id];
      if (!state || state.state !== 'on') return;

      if (state.attributes.brightness !== undefined) {
        totalBrightness += state.attributes.brightness;
        brightCount++;
      }

      if (state.attributes.color_temp !== undefined) {
        const kelvin = Math.round(1000000 / state.attributes.color_temp);
        totalTemp += kelvin;
        tempCount++;
      }

      if (state.attributes.rgb_color) {
        lastColor = state.attributes.rgb_color;
      }
    });

    return {
      brightness: brightCount > 0 ? Math.round(totalBrightness / brightCount) : 128,
      temperature: tempCount > 0 ? Math.round(totalTemp / tempCount) : 3500,
      color: lastColor
    };
  }

  /**
   * RENDERING
   */
  render() {
    if (!this.shadowRoot || !this._hass) return;

    const avgState = this._getAverageState();
    const showControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    const controlsPosition = this._config.controls_below ? 'below' : 'floating';
    const selectedCount = this._selectedLights.size;
    const selectionSubtitle = selectedCount > 0
      ? `${selectedCount} ${selectedCount === 1 ? 'light' : 'lights'} selected`
      : (this._lockPositions
        ? 'Tap a light to adjust or drag to multi-select.'
        : 'Arrange mode active — drag lights to reposition.');
    const arrangeHint = this._snapOnModifier ? 'Hold Alt to snap to the grid' : 'Grid snapping is active';

    this.shadowRoot.innerHTML = `

      <style>
        * { box-sizing: border-box; }

        :host {
          --bg-primary: #0b0d10;
          --bg-secondary: rgba(16, 18, 24, 0.9);
          --text-primary: rgba(255, 255, 255, 0.96);
          --text-secondary: rgba(255, 255, 255, 0.68);
          --text-tertiary: rgba(255, 255, 255, 0.4);
          --border-subtle: rgba(255, 255, 255, 0.08);
          --selection-glow: rgba(120, 162, 255, 0.45);
          --grid-dots: rgba(255, 255, 255, 0.04);
          font-family: 'Inter', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
        }

        ha-card {
          background:
            radial-gradient(circle at top right, rgba(120, 162, 255, 0.08), transparent 55%),
            var(--bg-primary);
          overflow: hidden;
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.04);
        }

        .header {
          padding: 18px 20px 16px;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
          align-items: center;
        }

        .title-block {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }

        .title {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
          letter-spacing: 0.2px;
        }

        .subtitle {
          font-size: 12px;
          color: var(--text-tertiary);
          letter-spacing: 0.4px;
          text-transform: uppercase;
          white-space: nowrap;
          text-overflow: ellipsis;
          overflow: hidden;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .action-btn,
        .settings-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: none;
          background: rgba(255, 255, 255, 0.04);
          color: var(--text-tertiary);
          border-radius: 999px;
          height: 34px;
          padding: 0 16px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          letter-spacing: 0.3px;
        }

        .action-btn:hover,
        .settings-btn:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-secondary);
        }

        .action-btn.active {
          background: rgba(120, 162, 255, 0.16);
          color: var(--text-primary);
          box-shadow: 0 0 0 1px rgba(120, 162, 255, 0.32) inset;
        }

        .settings-btn {
          width: 34px;
          padding: 0;
          border-radius: 10px;
          font-size: 18px;
        }

        .canvas-wrapper {
          position: relative;
          padding-bottom: ${this._config.controls_below ? '20px' : '0'};
        }

        .canvas {
          position: relative;
          width: 100%;
          height: ${this._config.canvas_height}px;
          background: radial-gradient(circle at center, rgba(255, 255, 255, 0.02), transparent 70%);
          overflow: hidden;
          cursor: default;
          user-select: none;
          touch-action: none;
        }

        .grid {
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, var(--grid-dots) 1px, transparent 1px);
          background-size: ${this._gridSize}px ${this._gridSize}px;
          pointer-events: none;
          opacity: ${this._lockPositions ? '0.35' : '0.55'};
          transition: opacity 0.2s ease;
        }

        .arrange-banner {
          position: absolute;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          padding: 10px 16px;
          border-radius: 999px;
          background: rgba(16, 22, 33, 0.86);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-secondary);
          font-size: 12px;
          letter-spacing: 0.3px;
          display: flex;
          align-items: center;
          gap: 8px;
          z-index: 30;
          backdrop-filter: blur(20px);
          pointer-events: none;
        }

        .arrange-banner::before {
          content: '';
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(120, 162, 255, 0.8);
          box-shadow: 0 0 0 4px rgba(120, 162, 255, 0.18);
        }

        .light {
          position: absolute;
          width: 68px;
          height: 68px;
          transform: translate(-50%, -50%);
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          cursor: pointer;
          transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), filter 0.25s ease;
          user-select: none;
          outline: none;
          --light-color: rgba(46, 49, 56, 0.95);
          --light-glow: rgba(0, 0, 0, 0.4);
          --light-progress: 0deg;
          --light-ring-opacity: 0;
        }

        .light.movable {
          cursor: grab;
        }

        .light.movable.dragging {
          cursor: grabbing;
        }

        .light-ring {
          position: absolute;
          inset: -6px;
          border-radius: 50%;
          background: conic-gradient(var(--light-color) var(--light-progress), rgba(255, 255, 255, 0.08) var(--light-progress));
          opacity: var(--light-ring-opacity);
          filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.35));
          transition: opacity 0.2s ease, filter 0.2s ease;
          pointer-events: none;
        }

        .light.on .light-ring {
          filter: drop-shadow(0 0 18px var(--light-glow));
        }

        .light.selected .light-ring {
          opacity: 1;
          filter: drop-shadow(0 0 22px var(--selection-glow));
        }

        .light-core {
          position: relative;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(0, 0, 0, 0.4));
          box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.32);
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          transition: transform 0.2s ease, background 0.3s ease;
        }

        .light.on .light-core {
          background:
            radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.6), transparent 60%),
            radial-gradient(circle at 65% 80%, rgba(255, 255, 255, 0.18), transparent 70%),
            var(--light-color);
        }

        .light.selected .light-core {
          transform: scale(1.04);
        }

        .light-icon {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: rgba(0, 0, 0, 0.25);
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(255, 255, 255, 0.75);
          transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
        }

        .light.on .light-icon {
          background: rgba(0, 0, 0, 0.18);
          color: #ffffff;
        }

        .light.selected .light-icon {
          transform: scale(1.08);
        }

        .light ha-icon {
          --mdc-icon-size: 20px;
          pointer-events: none;
        }

        .light-label {
          position: absolute;
          top: calc(100% + 10px);
          left: 50%;
          transform: translate(-50%, -6px);
          padding: 4px 10px;
          background: rgba(16, 22, 33, 0.9);
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 600;
          border-radius: 6px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease, transform 0.2s ease;
          z-index: 40;
          border: 1px solid rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(12px);
        }

        .light:hover .light-label,
        .light.selected .light-label,
        .light:focus-visible .light-label {
          opacity: 1;
          transform: translate(-50%, 0);
        }

        .light:focus-visible .light-ring {
          opacity: 1;
          filter: drop-shadow(0 0 22px var(--selection-glow));
        }

        .light.dragging {
          transform: translate(-50%, -50%) scale(1.08);
          z-index: 120;
        }

        .selection-box {
          position: absolute;
          border: 1px solid var(--selection-glow);
          background: rgba(120, 162, 255, 0.12);
          pointer-events: none;
          border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        }

        .controls-floating {
          position: absolute;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 24px;
          align-items: center;
          padding: 16px 22px;
          border-radius: 20px;
          background: rgba(14, 18, 24, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.06);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.25s ease, transform 0.25s ease;
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(22px);
        }

        .controls-floating.visible {
          opacity: 1;
          pointer-events: auto;
        }

        .controls-floating:not(.visible) {
          transform: translate(-50%, 20px);
        }

        .controls-below {
          margin: 24px 20px 8px;
          padding: 18px 20px;
          border-radius: 18px;
          background: rgba(14, 18, 24, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          gap: 24px;
          flex-wrap: wrap;
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
          backdrop-filter: blur(22px);
        }

        .color-wheel-mini {
          width: 240px;
          height: 240px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: radial-gradient(circle at center, rgba(255, 255, 255, 0.05), transparent 70%);
          box-shadow: inset 0 6px 16px rgba(0, 0, 0, 0.35);
        }

        .slider-group {
          display: flex;
          flex-direction: column;
          gap: 18px;
          min-width: 220px;
          flex: 1;
        }

        .slider-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .slider-icon {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.04);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          flex-shrink: 0;
        }

        .slider-icon ha-icon {
          --mdc-icon-size: 16px;
          pointer-events: none;
        }

        .slider {
          flex: 1;
          -webkit-appearance: none;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(90deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.16) 100%);
          outline: none;
          transition: background 0.2s ease;
          position: relative;
        }

        .slider.slider--brightness {
          background: linear-gradient(90deg, var(--slider-progress-color, rgba(248, 211, 106, 0.85)) 0%, var(--slider-progress-color, rgba(248, 211, 106, 0.85)) var(--slider-progress, 0%), rgba(255, 255, 255, 0.1) var(--slider-progress, 0%), rgba(255, 255, 255, 0.1) 100%);
        }

        .slider.slider--temperature {
          background:
            linear-gradient(90deg, rgba(255, 255, 255, 0.12) 0%, rgba(255, 255, 255, 0.12) var(--slider-progress, 0%), rgba(255, 255, 255, 0.06) var(--slider-progress, 0%), rgba(255, 255, 255, 0.06) 100%),
            linear-gradient(90deg, #ffb74d 0%, #ffe0b2 40%, #e0f7fa 70%, #64b5f6 100%);
        }

        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--slider-thumb-color, #ffffff);
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
          cursor: pointer;
        }

        .slider::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--slider-thumb-color, #ffffff);
          border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
          cursor: pointer;
        }

        .slider-value {
          font-size: 13px;
          color: var(--text-secondary);
          min-width: 52px;
          text-align: right;
          font-weight: 500;
          letter-spacing: 0.2px;
        }

        .settings-panel {
          position: absolute;
          top: 70px;
          right: 20px;
          background: rgba(14, 18, 24, 0.92);
          backdrop-filter: blur(24px);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 18px;
          min-width: 240px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease, transform 0.2s ease;
          transform: translateY(-6px);
          z-index: 100;
        }

        .settings-panel.visible {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0);
        }

        .settings-section {
          margin-bottom: 16px;
        }

        .settings-section:last-child {
          margin-bottom: 0;
        }

        .settings-label {
          font-size: 12px;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
          font-weight: 600;
        }

        .settings-option {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 0;
          color: var(--text-secondary);
          font-size: 14px;
        }

        .toggle {
          width: 44px;
          height: 24px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 12px;
          position: relative;
          cursor: pointer;
          transition: background 0.2s ease;
        }

        .toggle.on {
          background: rgba(120, 162, 255, 0.4);
        }

        .toggle::after {
          content: '';
          position: absolute;
          width: 20px;
          height: 20px;
          background: white;
          border-radius: 50%;
          top: 2px;
          left: 2px;
          transition: left 0.2s ease;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        }

        .toggle.on::after {
          left: 22px;
        }

        .settings-button {
          width: 100%;
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-secondary);
          border-radius: 10px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          transition: all 0.2s ease;
          margin-top: 8px;
        }

        .settings-button:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.18);
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(4px);
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-overlay.visible {
          display: flex;
        }

        .modal {
          background: rgba(14, 18, 24, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 24px;
          max-width: 640px;
          width: 90%;
          max-height: 80vh;
          overflow: auto;
          box-shadow: 0 25px 65px rgba(0, 0, 0, 0.6);
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .modal-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .modal-close {
          width: 34px;
          height: 34px;
          border: none;
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-tertiary);
          border-radius: 10px;
          cursor: pointer;
          font-size: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }

        .modal-close:hover {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text-secondary);
        }

        .yaml-output {
          background: rgba(11, 14, 18, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 8px;
          padding: 16px;
          font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
          font-size: 12px;
          line-height: 1.6;
          color: var(--text-primary);
          white-space: pre;
          overflow-x: auto;
          user-select: all;
        }

        .modal-hint {
          margin-top: 12px;
          font-size: 12px;
          color: var(--text-tertiary);
          text-align: center;
        }

        @media (max-width: 768px) {
          .controls-floating,
          .controls-below {
            flex-direction: column;
            gap: 18px;
          }

          .controls-floating {
            left: 20px;
            right: 20px;
            transform: none;
          }

          .controls-floating.visible {
            transform: none;
          }

          .slider-group {
            width: 100%;
            min-width: 0;
          }

          .header {
            flex-direction: column;
            align-items: flex-start;
          }

          .header-actions {
            width: 100%;
            justify-content: space-between;
          }
        }
      </style>

      
      <ha-card>
        <div class="header">
          <div class="title-block">
            <div class="title">${this._config.title}</div>
            <div class="subtitle">${selectionSubtitle}</div>
          </div>
          <div class="header-actions">
            <button class="action-btn ${this._lockPositions ? '' : 'active'}" id="arrangeToggle" aria-pressed="${!this._lockPositions}">
              ${this._lockPositions ? 'Arrange' : 'Done'}
            </button>
            ${this._config.show_settings_button ? `
              <button class="settings-btn" id="settingsBtn" aria-label="Settings">⚙</button>
            ` : ''}
          </div>
        </div>

        <div class="canvas-wrapper">
          <div class="canvas" id="canvas">
            <div class="grid"></div>
            ${!this._lockPositions ? `<div class="arrange-banner">Arrange mode · ${arrangeHint}</div>` : ''}
            ${this._renderLights()}
            ${controlsPosition === 'floating' ? this._renderControlsFloating(showControls, avgState) : ''}
            ${this._renderSettings()}
          </div>
          
          ${controlsPosition === 'below' ? this._renderControlsBelow(avgState) : ''}
        </div>
        
        ${this._renderYamlModal()}
      </ha-card>
    `;

    this._attachEventListeners();
    if ((showControls || this._config.always_show_controls) && this.shadowRoot.getElementById('colorWheelMini')) {
      this.drawColorWheel();
      this._updateControlValues(avgState);
    }
    this.updateLights();
  }

  _renderLights() {
    return this._config.entities.map(entity_id => {
      const pos = this._config.positions[entity_id] || { x: 50, y: 50 };
      const state = this._hass?.states[entity_id];
      if (!state) return '';

      const isOn = state.state === 'on';
      const isSelected = this._selectedLights.has(entity_id);
      const label = this._generateLabel(entity_id);
      const icon = this._resolveIcon(state);
      const colors = this._computeLightColors(state);
      const brightness = this._computeBrightness(state);
      const progressDeg = Math.max(0, Math.round(brightness * 360));
      const ringOpacity = isOn ? Math.min(1, 0.18 + brightness * 0.55).toFixed(2) : '0';
      const classes = ['light', isOn ? 'on' : 'off', isSelected ? 'selected' : '', !this._lockPositions ? 'movable' : '']
        .filter(Boolean)
        .join(' ');

      const friendlyName = state.attributes.friendly_name || entity_id;

      return `
        <div
          class="${classes}"
          style="left: ${pos.x}%; top: ${pos.y}%; --light-color: ${colors.base}; --light-glow: ${colors.glow}; --light-progress: ${progressDeg}deg; --light-ring-opacity: ${ringOpacity};"
          data-entity="${entity_id}"
          tabindex="0"
          role="button"
          aria-label="${friendlyName}"
          aria-pressed="${isSelected}"
        >
          <div class="light-ring"></div>
          <div class="light-core">
            <div class="light-icon">
              <ha-icon icon="${icon}"></ha-icon>
            </div>
          </div>
          <div class="light-label">${label}</div>
        </div>
      `;
    }).join('');
  }

  _renderControlsFloating(visible, avgState) {
    return `
      <div class="controls-floating ${visible ? 'visible' : ''}" id="controlsFloating">
        <canvas
          id="colorWheelMini"
          class="color-wheel-mini"
          width="240"
          height="240"
        ></canvas>

        <div class="slider-group">
          <div class="slider-row">
            <span class="slider-icon"><ha-icon icon="mdi:brightness-6"></ha-icon></span>
            <input
              type="range"
              class="slider slider--brightness"
              id="brightnessSlider"
              min="0"
              max="255"
              value="${avgState.brightness}"
            >
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness / 255) * 100)}%</span>
          </div>

          <div class="slider-row">
            <span class="slider-icon"><ha-icon icon="mdi:thermometer"></ha-icon></span>
            <input
              type="range"
              class="slider slider--temperature"
              id="temperatureSlider"
              min="2000"
              max="6500"
              value="${avgState.temperature}"
            >
            <span class="slider-value" id="temperatureValue">${avgState.temperature}K</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderControlsBelow(avgState) {
    return `
      <div class="controls-below" id="controlsBelow">
        <canvas
          id="colorWheelMini"
          class="color-wheel-mini" 
          width="240" 
          height="240"
        ></canvas>

        <div class="slider-group">
          <div class="slider-row">
            <span class="slider-icon"><ha-icon icon="mdi:brightness-6"></ha-icon></span>
            <input
              type="range"
              class="slider slider--brightness"
              id="brightnessSlider"
              min="0"
              max="255"
              value="${avgState.brightness}"
            >
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness / 255) * 100)}%</span>
          </div>

          <div class="slider-row">
            <span class="slider-icon"><ha-icon icon="mdi:thermometer"></ha-icon></span>
            <input
              type="range"
              class="slider slider--temperature"
              id="temperatureSlider"
              min="2000"
              max="6500"
              value="${avgState.temperature}"
            >
            <span class="slider-value" id="temperatureValue">${avgState.temperature}K</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderSettings() {
    return `
      <div class="settings-panel ${this._settingsOpen ? 'visible' : ''}" id="settingsPanel">
        <div class="settings-section">
          <div class="settings-label">Positioning</div>
          <div class="settings-option">
            <span>Lock Positions</span>
            <div class="toggle ${this._lockPositions ? 'on' : ''}" id="lockToggle"></div>
          </div>
        </div>
        
        <div class="settings-section">
          <div class="settings-label">Grid</div>
          <div class="settings-option">
            <span>Size: ${this._gridSize}px</span>
          </div>
        </div>
        
        <div class="settings-section">
          <button class="settings-button" id="exportBtn">Export Configuration</button>
        </div>
      </div>
    `;
  }

  _renderYamlModal() {
    return `
      <div class="modal-overlay ${this._yamlModalOpen ? 'visible' : ''}" id="yamlModal">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Configuration YAML</span>
            <button class="modal-close" id="closeModal">×</button>
          </div>
          <div class="yaml-output" id="yamlOutput">${this._generateYAML()}</div>
          <div class="modal-hint">Select all (Cmd/Ctrl+A) and copy (Cmd/Ctrl+C)</div>
        </div>
      </div>
    `;
  }

  /**
   * UPDATE CONTROL VALUES
   */
  _updateControlValues(avgState) {
    const brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    const brightnessValue = this.shadowRoot.getElementById('brightnessValue');
    const temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');
    const temperatureValue = this.shadowRoot.getElementById('temperatureValue');
    const accentColor = Array.isArray(avgState.color) ? `rgb(${avgState.color.join(',')})` : this._colorTemperatureToCss(avgState.temperature);

    if (brightnessSlider) {
      brightnessSlider.value = avgState.brightness;
      const brightnessPercent = Math.round((avgState.brightness / 255) * 100);
      brightnessSlider.style.setProperty('--slider-progress', `${Math.min(100, Math.max(0, brightnessPercent))}%`);
      brightnessSlider.style.setProperty('--slider-progress-color', accentColor);
      brightnessSlider.style.setProperty('--slider-thumb-color', accentColor);
    }
    if (brightnessValue) {
      brightnessValue.textContent = `${Math.round((avgState.brightness / 255) * 100)}%`;
    }
    if (temperatureSlider) {
      temperatureSlider.value = avgState.temperature;
      const tempPercent = Math.round(((avgState.temperature - 2000) / (6500 - 2000)) * 100);
      temperatureSlider.style.setProperty('--slider-progress', `${Math.min(100, Math.max(0, tempPercent))}%`);
      temperatureSlider.style.setProperty('--slider-thumb-color', this._colorTemperatureToCss(avgState.temperature));
    }
    if (temperatureValue) {
      temperatureValue.textContent = `${avgState.temperature}K`;
    }
  }

  /**
   * EVENT HANDLING
   */
  connectedCallback() {
    this._boundGlobalMouseUp = (e) => this._handleGlobalMouseUp(e);
    this._boundGlobalMouseMove = (e) => this._handleGlobalMouseMove(e);
    this._boundKeyDown = (e) => this._handleKeyDown(e);
    
    document.addEventListener('keydown', this._boundKeyDown);
  }

  disconnectedCallback() {
    this._detachEventListeners();
    if (this._boundKeyDown) {
      document.removeEventListener('keydown', this._boundKeyDown);
    }
  }

  _attachEventListeners() {
    this._detachEventListeners();

    // Settings button
    const settingsBtn = this.shadowRoot.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._settingsOpen = !this._settingsOpen;
        this.render();
      });
    }

    const arrangeToggle = this.shadowRoot.getElementById('arrangeToggle');
    if (arrangeToggle) {
      arrangeToggle.addEventListener('click', (e) => {
        e.preventDefault();
        this._lockPositions = !this._lockPositions;
        this.render();
      });
    }

    // Close settings when clicking outside
    this._boundCloseSettings = (e) => {
      if (!this._settingsOpen) return;
      const path = e.composedPath ? e.composedPath() : [];
      const clickedInsidePanel = path.some(node => node?.classList?.contains && node.classList.contains('settings-panel'));
      const clickedSettingsBtn = path.some(node => node?.id === 'settingsBtn');
      if (!clickedInsidePanel && !clickedSettingsBtn) {
        this._settingsOpen = false;
        this.render();
      }
    };
    document.addEventListener('click', this._boundCloseSettings);

    // Lock toggle
    const lockToggle = this.shadowRoot.getElementById('lockToggle');
    if (lockToggle) {
      lockToggle.addEventListener('click', () => {
        this._lockPositions = !this._lockPositions;
        this.render();
      });
    }

    // Export button
    const exportBtn = this.shadowRoot.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        this._yamlModalOpen = true;
        this.render();
      });
    }

    // Close modal
    const closeModal = this.shadowRoot.getElementById('closeModal');
    if (closeModal) {
      closeModal.addEventListener('click', () => {
        this._yamlModalOpen = false;
        this.render();
      });
    }

    // Close modal on overlay click
    const modalOverlay = this.shadowRoot.getElementById('yamlModal');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
          this._yamlModalOpen = false;
          this.render();
        }
      });
    }

    // Light orbs
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      // Mouse events
      light.addEventListener('mousedown', (e) => this._handleLightMouseDown(e, light));
      light.addEventListener('click', (e) => this._handleLightClick(e, light));

      // Touch events for mobile multi-select
      light.addEventListener('touchstart', (e) => {
        this._handleLightTouchStart(e, light);
      }, { passive: false });
      light.addEventListener('touchend', (e) => {
        this._handleLightTouchEnd(e, light);
      });
    });

    // Canvas for selection box
    const canvas = this.shadowRoot.getElementById('canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', (e) => this._handleCanvasMouseDown(e));
      canvas.addEventListener('touchstart', (e) => this._handleCanvasTouchStart(e), { passive: false });
    }

    // Color wheel
    const colorWheel = this.shadowRoot.getElementById('colorWheelMini');
    if (colorWheel) {
      colorWheel.addEventListener('mousedown', (e) => this._handleColorWheelClick(e));
      colorWheel.addEventListener('touchstart', (e) => this._handleColorWheelClick(e));
    }

    // Sliders
    const brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    const temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');
    
    if (brightnessSlider) {
      brightnessSlider.addEventListener('input', (e) => this._handleBrightnessChange(e));
    }
    if (temperatureSlider) {
      temperatureSlider.addEventListener('input', (e) => this._handleTemperatureChange(e));
    }

    // Global listeners
    document.addEventListener('mouseup', this._boundGlobalMouseUp);
    document.addEventListener('touchend', this._boundGlobalMouseUp);
    document.addEventListener('mousemove', this._boundGlobalMouseMove);
    document.addEventListener('touchmove', this._boundGlobalMouseMove, { passive: false });
    this._documentListenersAttached = true;
  }

  _detachEventListeners() {
    if (this._boundCloseSettings) {
      document.removeEventListener('click', this._boundCloseSettings);
      this._boundCloseSettings = null;
    }

    if (this._documentListenersAttached) {
      document.removeEventListener('mouseup', this._boundGlobalMouseUp);
      document.removeEventListener('touchend', this._boundGlobalMouseUp);
      document.removeEventListener('mousemove', this._boundGlobalMouseMove);
      document.removeEventListener('touchmove', this._boundGlobalMouseMove);
      this._documentListenersAttached = false;
    }
  }

  _handleKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this._undo();
    }
    
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this._redo();
    }
    
    if (e.key === 'Escape') {
      this._selectedLights.clear();
      this.render();
    }
  }

  /**
   * MOBILE TOUCH SUPPORT FOR MULTI-SELECT
   */
  _handleLightTouchStart(e, light) {
    const entity_id = light.dataset.entity;

    if (e.cancelable) {
      e.preventDefault();
    }

    // Start long press timer for multi-select
    this._longPressTimer = setTimeout(() => {
      this._longPressTriggered = true;
      // Vibrate if supported
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
      // Toggle selection
      if (this._selectedLights.has(entity_id)) {
        this._selectedLights.delete(entity_id);
      } else {
        this._selectedLights.add(entity_id);
      }
      this.render();
      if (this._selectedLights.size > 0) {
        this.drawColorWheel();
      }
    }, 500); // 500ms long press

    // Also handle dragging
    if (!this._lockPositions) {
      this._handleLightMouseDown(e, light);
    }
  }

  _handleLightTouchEnd(e, light) {
    // Clear long press timer
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    // If long press was triggered, don't do normal click
    if (this._longPressTriggered) {
      this._longPressTriggered = false;
      e.preventDefault();
      return;
    }

    // Normal tap = single select (if not dragging)
    if (!this._dragState) {
      this._handleLightClick(e, light);
    }
  }

  _handleLightMouseDown(e, light) {
    if (this._lockPositions) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const entity_id = light.dataset.entity;
    const canvas = this.shadowRoot.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const currentLeft = parseFloat(light.style.left);
    const currentTop = parseFloat(light.style.top);
    
    this._dragState = {
      entity: entity_id,
      startX: clientX,
      startY: clientY,
      initialLeft: currentLeft,
      initialTop: currentTop,
      canvasRect: rect,
      moved: false // Track if actually moved
    };
    
    light.classList.add('dragging');
    
    // Save history
    if (this._history.length === 0 || 
        JSON.stringify(this._history[this._historyIndex]) !== JSON.stringify(this._config.positions)) {
      this._saveHistory();
    }
  }

  _handleLightClick(e, light) {
    // If we were dragging, don't select
    if (this._dragState?.moved) {
      return;
    }
    
    e.stopPropagation();
    const entity_id = light.dataset.entity;
    
    if (e.shiftKey) {
      // Multi-select
      if (this._selectedLights.has(entity_id)) {
        this._selectedLights.delete(entity_id);
      } else {
        this._selectedLights.add(entity_id);
      }
    } else {
      // Single select
      this._selectedLights.clear();
      this._selectedLights.add(entity_id);
    }
    
    this.render();
    if (this._selectedLights.size > 0) {
      this.drawColorWheel();
    }
  }

  _handleCanvasMouseDown(e) {
    if (e.target.id !== 'canvas' && !e.target.classList.contains('grid')) return;

    if (e.cancelable) {
      e.preventDefault();
    }

    const canvas = this.shadowRoot.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    this._selectionStart = { x, y };
    this._selectionBox = document.createElement('div');
    this._selectionBox.className = 'selection-box';
    canvas.appendChild(this._selectionBox);
    
    if (!e.shiftKey) {
      this._selectedLights.clear();
      this.render();
    }
  }

  _handleCanvasTouchStart(e) {
    if (e.target.id !== 'canvas' && !e.target.classList.contains('grid')) return;
    if (e.cancelable) {
      e.preventDefault();
    }
    this._handleCanvasMouseDown(e);
  }

  _handleGlobalMouseMove(e) {
    // Handle light dragging
    if (this._dragState) {
      e.preventDefault();
      
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      
      const deltaX = clientX - this._dragState.startX;
      const deltaY = clientY - this._dragState.startY;
      
      // Mark as moved if dragged more than 5px
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        this._dragState.moved = true;
      }
      
      const rect = this._dragState.canvasRect;
      const deltaXPercent = (deltaX / rect.width) * 100;
      const deltaYPercent = (deltaY / rect.height) * 100;
      
      let newLeft = this._dragState.initialLeft + deltaXPercent;
      let newTop = this._dragState.initialTop + deltaYPercent;
      
      // Apply snapping
      const snapped = this._snapToGrid(newLeft, newTop, e);
      newLeft = snapped.x;
      newTop = snapped.y;
      
      // Clamp to bounds
      newLeft = Math.max(0, Math.min(100, newLeft));
      newTop = Math.max(0, Math.min(100, newTop));
      
      const light = this.shadowRoot.querySelector(`[data-entity="${this._dragState.entity}"]`);
      if (light) {
        light.style.left = `${newLeft}%`;
        light.style.top = `${newTop}%`;
      }
      
      return;
    }
    
    // Handle selection box
    if (this._selectionBox && this._selectionStart) {
      e.preventDefault();
      
      const canvas = this.shadowRoot.getElementById('canvas');
      const rect = canvas.getBoundingClientRect();
      
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      
      const currentX = clientX - rect.left;
      const currentY = clientY - rect.top;
      
      const left = Math.min(this._selectionStart.x, currentX);
      const top = Math.min(this._selectionStart.y, currentY);
      const width = Math.abs(currentX - this._selectionStart.x);
      const height = Math.abs(currentY - this._selectionStart.y);
      
      this._selectionBox.style.left = `${left}px`;
      this._selectionBox.style.top = `${top}px`;
      this._selectionBox.style.width = `${width}px`;
      this._selectionBox.style.height = `${height}px`;
      
      this._selectLightsInBox(left, top, width, height);
    }
  }

  _handleGlobalMouseUp(e) {
    // Handle drag end - FIX: Properly clear drag state
    if (this._dragState) {
      const light = this.shadowRoot.querySelector(`[data-entity="${this._dragState.entity}"]`);
      if (light) {
        light.classList.remove('dragging');
        
        const finalLeft = parseFloat(light.style.left);
        const finalTop = parseFloat(light.style.top);
        
        this._config.positions[this._dragState.entity] = { 
          x: finalLeft, 
          y: finalTop 
        };
      }
      
      this._dragState = null; // CRITICAL: Clear drag state
      return;
    }

    // Handle selection box end
    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
      this._selectionStart = null;
      this.render();
      if (this._selectedLights.size > 0) {
        this.drawColorWheel();
      }
    }
  }

  _selectLightsInBox(left, top, width, height) {
    const lights = this.shadowRoot.querySelectorAll('.light');
    const canvas = this.shadowRoot.getElementById('canvas');
    const rect = canvas.getBoundingClientRect();

    lights.forEach(light => {
      const lightRect = light.getBoundingClientRect();
      const lightX = lightRect.left - rect.left + lightRect.width / 2;
      const lightY = lightRect.top - rect.top + lightRect.height / 2;

      if (lightX >= left && lightX <= left + width && 
          lightY >= top && lightY <= top + height) {
        this._selectedLights.add(light.dataset.entity);
        light.classList.add('selected');
      }
    });
  }

  /**
   * COLOR CONTROL
   */
  _handleColorWheelClick(e) {
    const controlledEntities = this._selectedLights.size > 0 
      ? Array.from(this._selectedLights)
      : (this._config.default_entity ? [this._config.default_entity] : []);
    
    if (controlledEntities.length === 0) return;

    const canvas = this.shadowRoot.getElementById('colorWheelMini');
    const rect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;

    this._applyColorFromWheel(scaledX, scaledY, controlledEntities);
  }

  _applyColorFromWheel(x, y, entities) {
    const canvas = this.shadowRoot.getElementById('colorWheelMini');
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1);
    const [r, g, b] = imageData.data;

    entities.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', {
        entity_id: entity_id,
        rgb_color: [r, g, b]
      });
    });
  }

  _handleBrightnessChange(e) {
    const controlledEntities = this._selectedLights.size > 0 
      ? Array.from(this._selectedLights)
      : (this._config.default_entity ? [this._config.default_entity] : []);
    
    if (controlledEntities.length === 0) return;

    const brightness = parseInt(e.target.value);
    const brightnessValue = this.shadowRoot.getElementById('brightnessValue');
    if (brightnessValue) {
      brightnessValue.textContent = `${Math.round((brightness / 255) * 100)}%`;
    }

    controlledEntities.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', {
        entity_id: entity_id,
        brightness: brightness
      });
    });
  }

  _handleTemperatureChange(e) {
    const controlledEntities = this._selectedLights.size > 0 
      ? Array.from(this._selectedLights)
      : (this._config.default_entity ? [this._config.default_entity] : []);
    
    if (controlledEntities.length === 0) return;

    const temperature = parseInt(e.target.value);
    const temperatureValue = this.shadowRoot.getElementById('temperatureValue');
    if (temperatureValue) {
      temperatureValue.textContent = `${temperature}K`;
    }

    const mireds = Math.round(1000000 / temperature);

    controlledEntities.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', {
        entity_id: entity_id,
        color_temp: mireds
      });
    });
  }

  drawColorWheel() {
    const canvas = this.shadowRoot.getElementById('colorWheelMini');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = canvas.width / 2;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let angle = 0; angle < 360; angle += 1) {
      const startAngle = (angle - 90) * Math.PI / 180;
      const endAngle = (angle - 89) * Math.PI / 180;

      for (let r = 0; r < radius; r += 1) {
        const sat = (r / radius) * 100;
        const hue = angle;
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, startAngle, endAngle);
        ctx.strokeStyle = `hsl(${hue}, ${sat}%, 50%)`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // White center
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 0.2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  updateLights() {
    if (!this._hass) return;

    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const entity_id = light.dataset.entity;
      const state = this._hass.states[entity_id];
      if (!state) return;

      const isOn = state.state === 'on';
      const colors = this._computeLightColors(state);
      const brightness = this._computeBrightness(state);
      const progressDeg = Math.max(0, Math.round(brightness * 360));
      const ringOpacity = isOn ? Math.min(1, 0.18 + brightness * 0.55).toFixed(2) : '0';

      light.style.setProperty('--light-color', colors.base);
      light.style.setProperty('--light-glow', colors.glow);
      light.style.setProperty('--light-progress', `${progressDeg}deg`);
      light.style.setProperty('--light-ring-opacity', ringOpacity);
      light.classList.toggle('off', !isOn);
      light.classList.toggle('on', isOn);
      light.classList.toggle('movable', !this._lockPositions);
      light.classList.toggle('selected', this._selectedLights.has(entity_id));

      const iconEl = light.querySelector('ha-icon');
      if (iconEl) {
        iconEl.setAttribute('icon', this._resolveIcon(state));
      }

      const labelEl = light.querySelector('.light-label');
      if (labelEl) {
        labelEl.textContent = this._generateLabel(entity_id);
      }

      light.setAttribute('aria-pressed', this._selectedLights.has(entity_id));
    });

    // Update control values if controls are visible
    if (this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) {
      const avgState = this._getAverageState();
      this._updateControlValues(avgState);
    }
  }

  /**
   * YAML GENERATION
   */
  _generateYAML() {
    const indent = '  ';
    let yaml = `type: custom:spatial-light-color-card\n`;
    yaml += `title: ${this._config.title}\n`;
    yaml += `canvas_height: ${this._config.canvas_height}\n`;
    
    if (this._config.default_entity) {
      yaml += `default_entity: ${this._config.default_entity}\n`;
    }
    
    if (this._config.always_show_controls) {
      yaml += `always_show_controls: true\n`;
    }
    
    if (!this._config.controls_below) {
      yaml += `controls_below: false\n`;
    }
    
    if (!this._config.show_settings_button) {
      yaml += `show_settings_button: false\n`;
    }
    
    yaml += `entities:\n`;
    this._config.entities.forEach(entity => {
      yaml += `${indent}- ${entity}\n`;
    });
    
    yaml += `positions:\n`;
    Object.entries(this._config.positions).forEach(([entity, pos]) => {
      yaml += `${indent}${entity}:\n`;
      yaml += `${indent}${indent}x: ${pos.x.toFixed(2)}\n`;
      yaml += `${indent}${indent}y: ${pos.y.toFixed(2)}\n`;
    });

    return yaml;
  }

  getCardSize() {
    return 8;
  }

  static getStubConfig() {
    return {
      entities: [],
      positions: {},
      title: 'Lights',
      canvas_height: 450,
      grid_size: 25,
      label_mode: 'smart',
      show_settings_button: true,
      always_show_controls: false,
      controls_below: true,
      default_entity: null
    };
  }
}

customElements.define('spatial-light-color-card', SpatialLightColorCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'spatial-light-color-card',
  name: 'Spatial Light Color Card',
  description: 'Minimalist spatial light control with intelligent interactions',
  preview: true
});
