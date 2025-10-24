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

    // Settings
    this._gridSize = 25;
    this._snapOnModifier = true;
    this._lockPositions = true; // DEFAULT TO LOCKED

    // Interaction helpers
    this._activePointerId = null;
    this._pointerDownLight = null;
    this._activeColorWheelPointer = null;
    this._colorWheelActive = false;
    this._currentCanvas = null;
    this._currentColorWheel = null;
    this._selectionBaseline = new Set();
    this._selectionAdditive = false;

    // Bound handlers (stable references for add/removeEventListener)
    this._documentClickHandler = (e) => this._handleDocumentClick(e);
    this._pointerDownHandler = (e) => this._onPointerDown(e);
    this._pointerMoveHandler = (e) => this._onPointerMove(e);
    this._pointerUpHandler = (e) => this._onPointerUp(e);
    this._colorWheelPointerDownHandler = (e) => this._handleColorWheelPointer(e, 'down');
    this._colorWheelPointerMoveHandler = (e) => this._handleColorWheelPointer(e, 'move');
    this._colorWheelPointerUpHandler = (e) => this._handleColorWheelPointer(e, 'up');
    this._brightnessInputHandler = (e) => this._handleBrightnessChange(e);
    this._temperatureInputHandler = (e) => this._handleTemperatureChange(e);
    this._keyDownHandler = (e) => this._handleKeyDown(e);
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities)) {
      throw new Error('You must specify entities as an array');
    }

    const normalizedPositions = {};
    if (config.positions && typeof config.positions === 'object') {
      Object.entries(config.positions).forEach(([entity, pos]) => {
        if (!pos || typeof pos !== 'object') return;
        const parsedX = typeof pos.x === 'number' ? pos.x : parseFloat(pos.x);
        const parsedY = typeof pos.y === 'number' ? pos.y : parseFloat(pos.y);
        if (Number.isFinite(parsedX) && Number.isFinite(parsedY)) {
          normalizedPositions[entity] = { x: parsedX, y: parsedY };
        }
      });
    }

    this._config = {
      entities: config.entities,
      positions: normalizedPositions,
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

  _kelvinToRGB(kelvin) {
    const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;
    let red;
    let green;
    let blue;

    if (temp <= 66) {
      red = 255;
    } else {
      red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
      red = Math.min(255, Math.max(0, red));
    }

    if (temp <= 66) {
      green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    } else {
      green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    }
    green = Math.min(255, Math.max(0, green));

    if (temp >= 66) {
      blue = 255;
    } else if (temp <= 19) {
      blue = 0;
    } else {
      blue = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
      blue = Math.min(255, Math.max(0, blue));
    }

    return [Math.round(red), Math.round(green), Math.round(blue)];
  }

  /**
   * RENDERING
   */
  render() {
    if (!this.shadowRoot || !this._hass) return;

    this._detachEventListeners();

    const avgState = this._getAverageState();
    const showControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    const controlsPosition = this._config.controls_below ? 'below' : 'floating';
    const selectedCount = this._selectedLights.size;
    const selectionLabel = selectedCount > 0
      ? `${selectedCount} selected`
      : (this._config.default_entity ? 'Default control active' : 'Tap a light to select');
    const arrangeActive = !this._lockPositions;

    this.shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; }

        :host {
          --bg-primary: #080808;
          --bg-secondary: #151515;
          --bg-tertiary: rgba(255, 255, 255, 0.05);
          --text-primary: rgba(255, 255, 255, 0.96);
          --text-secondary: rgba(255, 255, 255, 0.62);
          --text-tertiary: rgba(255, 255, 255, 0.38);
          --border-subtle: rgba(255, 255, 255, 0.08);
          --selection-glow: rgba(110, 150, 255, 0.45);
          --grid-dots: rgba(255, 255, 255, 0.05);
          --warm-temp: #FFB457;
          --neutral-temp: #FFEED0;
          --cool-temp: #7EC7FF;
          --brand-accent: #8C9CFF;
          font-family: "Inter", "SF Pro Display", "Roboto", sans-serif;
        }

        ha-card {
          background: var(--bg-primary);
          overflow: hidden;
          border-radius: 20px;
          border: 1px solid rgba(255, 255, 255, 0.04);
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.45);
        }

        .header {
          padding: 18px 22px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--border-subtle);
        }

        .title-block {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .title {
          font-size: 17px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
          letter-spacing: 0.2px;
        }

        .subtitle {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.7px;
          color: var(--text-tertiary);
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .mode-btn {
          border: 1px solid var(--border-subtle);
          background: var(--bg-tertiary);
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 8px 14px;
          font-size: 12px;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .mode-btn:hover {
          border-color: rgba(255, 255, 255, 0.18);
          color: var(--text-primary);
        }

        .mode-btn.active {
          background: rgba(140, 156, 255, 0.18);
          border-color: rgba(140, 156, 255, 0.5);
          color: var(--text-primary);
        }

        .settings-btn {
          width: 34px;
          height: 34px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid transparent;
        }

        .settings-btn:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-primary);
          border-color: rgba(255, 255, 255, 0.12);
        }

        .settings-btn ha-icon {
          width: 18px;
          height: 18px;
        }

        .canvas-wrapper {
          position: relative;
        }

        .canvas {
          position: relative;
          width: 100%;
          height: ${this._config.canvas_height}px;
          background: var(--bg-primary);
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
          opacity: 1;
        }

        .light {
          position: absolute;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          cursor: ${this._lockPositions ? 'pointer' : 'grab'};
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                      box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                      background 0.2s ease;
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          padding: 0;
          background: linear-gradient(135deg, #2d2d2d 0%, #171717 100%);
        }

        .light::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: inherit;
          box-shadow:
            0 6px 18px rgba(0, 0, 0, 0.35),
            inset 0 3px 10px rgba(0, 0, 0, 0.25);
        }

        .light.on::after {
          content: '';
          position: absolute;
          inset: -10px;
          border-radius: 50%;
          background: inherit;
          filter: blur(18px);
          opacity: 0.4;
          z-index: -1;
        }

        .light.off {
          opacity: 0.52;
        }

        .light.off::after {
          display: none;
        }

        .light-icon {
          position: relative;
          z-index: 1;
          width: 28px;
          height: 28px;
          color: var(--light-icon-color, rgba(255, 255, 255, 0.75));
          transition: color 0.2s ease, transform 0.2s ease;
        }

        .light.selected .light-icon {
          transform: scale(1.08);
        }

        .light-label {
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          padding: 4px 8px;
          background: var(--bg-secondary);
          color: var(--text-primary);
          font-size: 11px;
          font-weight: 600;
          border-radius: 4px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.15s ease;
          z-index: 100;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .light:hover .light-label {
          opacity: 1;
        }

        .light.selected {
          z-index: 10;
        }

        .light.selected::before {
          box-shadow:
            0 0 0 2px rgba(255, 255, 255, 0.55),
            0 0 0 5px var(--selection-glow),
            0 6px 18px rgba(0, 0, 0, 0.35),
            inset 0 3px 10px rgba(0, 0, 0, 0.25);
        }

        .light.dragging {
          cursor: grabbing;
          z-index: 100;
          transform: translate(-50%, -50%) scale(1.05);
        }

        .selection-box {
          position: absolute;
          border: 1px solid var(--selection-glow);
          background: rgba(120, 160, 255, 0.1);
          pointer-events: none;
          border-radius: 2px;
        }

        .controls-floating {
          position: absolute;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(22, 22, 22, 0.96);
          backdrop-filter: blur(20px);
          border: 1px solid var(--border-subtle);
          border-radius: 16px;
          padding: 16px 20px;
          display: flex;
          gap: 20px;
          align-items: center;
          box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
          z-index: 50;
        }

        .controls-floating.visible {
          opacity: 1;
          pointer-events: auto;
        }

        .controls-below {
          padding: 20px;
          border-top: 1px solid var(--border-subtle);
          background: var(--bg-primary);
          display: ${showControls ? 'flex' : 'none'};
          gap: 24px;
          align-items: center;
          justify-content: center;
        }

        .color-wheel-mini {
          width: 120px;
          height: 120px;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          flex-shrink: 0;
        }

        .color-wheel-mini:active {
          transform: scale(0.98);
        }

        .slider-group {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-width: 180px;
          flex: 1;
          max-width: 400px;
        }

        .slider-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .slider-icon {
          font-size: 16px;
          opacity: 0.6;
          flex-shrink: 0;
        }

        .slider {
          flex: 1;
          -webkit-appearance: none;
          height: 4px;
          border-radius: 2px;
          background: rgba(255, 255, 255, 0.1);
          outline: none;
          transition: background 0.3s ease;
        }

        .slider[data-type="brightness"] {
          background: linear-gradient(90deg, rgba(0, 0, 0, 0.6) 0%, rgba(255, 255, 255, 0.85) 100%);
        }

        .slider[data-type="temperature"] {
          background: linear-gradient(90deg, var(--warm-temp) 0%, var(--neutral-temp) 50%, var(--cool-temp) 100%);
        }

        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(0, 0, 0, 0.1);
        }

        .slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          border: 1px solid rgba(0, 0, 0, 0.1);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }

        .slider-value {
          font-size: 13px;
          color: var(--text-secondary);
          min-width: 45px;
          text-align: right;
          font-weight: 500;
          flex-shrink: 0;
        }

        .settings-panel {
          position: absolute;
          top: 62px;
          right: 22px;
          background: rgba(20, 20, 20, 0.96);
          backdrop-filter: blur(20px);
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          padding: 16px;
          min-width: 240px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
          z-index: 100;
        }

        .settings-panel.visible {
          opacity: 1;
          pointer-events: auto;
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
          width: 40px;
          height: 22px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 11px;
          position: relative;
          cursor: pointer;
          transition: background 0.2s ease;
        }

        .toggle.on {
          background: rgba(140, 156, 255, 0.5);
        }

        .toggle::after {
          content: '';
          position: absolute;
          width: 18px;
          height: 18px;
          background: white;
          border-radius: 50%;
          top: 2px;
          left: 2px;
          transition: left 0.2s ease;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .toggle.on::after {
          left: 20px;
        }

        .settings-button {
          width: 100%;
          padding: 10px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.2s ease;
          margin-top: 8px;
        }

        .settings-button:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.15);
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.7);
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
          background: var(--bg-secondary);
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          padding: 24px;
          max-width: 600px;
          width: 90%;
          max-height: 80vh;
          overflow: auto;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
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
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          border-radius: 6px;
          cursor: pointer;
          font-size: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }

        .modal-close:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text-secondary);
        }

        .yaml-output {
          background: var(--bg-primary);
          border: 1px solid var(--border-subtle);
          border-radius: 6px;
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
            gap: 16px;
          }

          .controls-floating {
            left: 20px;
            right: 20px;
            transform: none;
          }

          .slider-group {
            width: 100%;
          }
        }
      </style>

      <ha-card>
        <div class="header">
          <div class="title-block">
            <h2 class="title">${this._config.title}</h2>
            <span class="subtitle">${selectionLabel}</span>
          </div>
          <div class="header-actions">
            <button class="mode-btn ${arrangeActive ? 'active' : ''}" id="arrangeBtn" aria-label="${arrangeActive ? 'Exit arrange mode' : 'Enter arrange mode'}" aria-pressed="${arrangeActive}">
              ${arrangeActive ? 'Done' : 'Arrange'}
            </button>
            ${this._config.show_settings_button ? `
              <button class="settings-btn" id="settingsBtn" aria-label="Settings">
                <ha-icon icon="mdi:cog-outline"></ha-icon>
              </button>
            ` : ''}
          </div>
        </div>

        <div class="canvas-wrapper">
          <div class="canvas" id="canvas">
            <div class="grid"></div>
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
      this._updateSliderVisuals(avgState);
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

      const icon = state.attributes.icon
        ? state.attributes.icon
        : (isOn ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline');

      let fillColor = 'linear-gradient(135deg, #2d2d2d 0%, #171717 100%)';
      if (isOn && state.attributes.rgb_color) {
        const [r, g, b] = state.attributes.rgb_color;
        fillColor = `radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), rgb(${r}, ${g}, ${b})`;
      } else if (isOn && state.attributes.color_temp !== undefined) {
        const kelvin = Math.round(1000000 / state.attributes.color_temp);
        const [r, g, b] = this._kelvinToRGB(kelvin);
        fillColor = `radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), rgb(${r}, ${g}, ${b})`;
      } else if (isOn) {
        fillColor = 'radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), #ffd180';
      }

      const iconColor = isOn ? '#0f0f0f' : 'rgba(255, 255, 255, 0.65)';

      return `
        <div
          class="light ${isOn ? 'on' : 'off'} ${isSelected ? 'selected' : ''}"
          style="left: ${pos.x}%; top: ${pos.y}%; background: ${fillColor}; --light-icon-color: ${iconColor};"
          data-entity="${entity_id}"
          tabindex="0"
          role="button"
          aria-label="${state.attributes.friendly_name}"
          aria-pressed="${isSelected}"
        >
          <ha-icon class="light-icon" icon="${icon}"></ha-icon>
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
            <span class="slider-icon">💡</span>
            <input
              type="range"
              class="slider"
              data-type="brightness"
              id="brightnessSlider"
              min="0"
              max="255"
              value="${avgState.brightness}"
            >
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness / 255) * 100)}%</span>
          </div>
          
          <div class="slider-row">
            <span class="slider-icon">🌡️</span>
            <input
              type="range"
              class="slider"
              data-type="temperature"
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
            <span class="slider-icon">💡</span>
            <input
              type="range"
              class="slider"
              data-type="brightness"
              id="brightnessSlider"
              min="0"
              max="255"
              value="${avgState.brightness}"
            >
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness / 255) * 100)}%</span>
          </div>
          
          <div class="slider-row">
            <span class="slider-icon">🌡️</span>
            <input
              type="range"
              class="slider"
              data-type="temperature"
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

    if (brightnessSlider) {
      brightnessSlider.value = avgState.brightness;
    }
    if (brightnessValue) {
      brightnessValue.textContent = `${Math.round((avgState.brightness / 255) * 100)}%`;
    }
    if (temperatureSlider) {
      temperatureSlider.value = avgState.temperature;
    }
    if (temperatureValue) {
      temperatureValue.textContent = `${avgState.temperature}K`;
    }
  }

  _updateSliderVisuals(avgState) {
    const brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    const temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');

    if (brightnessSlider) {
      const color = Array.isArray(avgState.color)
        ? `rgb(${avgState.color[0]}, ${avgState.color[1]}, ${avgState.color[2]})`
        : 'rgba(255, 255, 255, 0.9)';
      brightnessSlider.style.background = `linear-gradient(90deg, rgba(0, 0, 0, 0.65) 0%, ${color} 100%)`;
    }

    if (temperatureSlider) {
      temperatureSlider.style.background = 'linear-gradient(90deg, var(--warm-temp) 0%, var(--neutral-temp) 50%, var(--cool-temp) 100%)';
    }
  }

  _detachEventListeners() {
    if (this._currentCanvas) {
      this._currentCanvas.removeEventListener('pointerdown', this._pointerDownHandler);
      this._currentCanvas = null;
    }

    if (this._currentColorWheel) {
      this._currentColorWheel.removeEventListener('pointerdown', this._colorWheelPointerDownHandler);
      this._currentColorWheel.removeEventListener('pointermove', this._colorWheelPointerMoveHandler);
      this._currentColorWheel.removeEventListener('pointerup', this._colorWheelPointerUpHandler);
      this._currentColorWheel.removeEventListener('pointercancel', this._colorWheelPointerUpHandler);
      this._currentColorWheel = null;
    }

    window.removeEventListener('pointermove', this._pointerMoveHandler);
    window.removeEventListener('pointerup', this._pointerUpHandler);
    window.removeEventListener('pointercancel', this._pointerUpHandler);
    document.removeEventListener('click', this._documentClickHandler);
  }

  /**
   * EVENT HANDLING
   */
  connectedCallback() {
    document.addEventListener('keydown', this._keyDownHandler);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._keyDownHandler);
    this._detachEventListeners();
  }

  _attachEventListeners() {
    const settingsBtn = this.shadowRoot.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._settingsOpen = !this._settingsOpen;
        this.render();
      });
    }

    const arrangeBtn = this.shadowRoot.getElementById('arrangeBtn');
    if (arrangeBtn) {
      arrangeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this._lockPositions = !this._lockPositions;
        this.render();
      });
    }

    const lockToggle = this.shadowRoot.getElementById('lockToggle');
    if (lockToggle) {
      lockToggle.addEventListener('click', () => {
        this._lockPositions = !this._lockPositions;
        this.render();
      });
    }

    const exportBtn = this.shadowRoot.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        this._yamlModalOpen = true;
        this.render();
      });
    }

    const closeModal = this.shadowRoot.getElementById('closeModal');
    if (closeModal) {
      closeModal.addEventListener('click', () => {
        this._yamlModalOpen = false;
        this.render();
      });
    }

    const modalOverlay = this.shadowRoot.getElementById('yamlModal');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
          this._yamlModalOpen = false;
          this.render();
        }
      });
    }

    this._currentCanvas = this.shadowRoot.getElementById('canvas');
    if (this._currentCanvas) {
      this._currentCanvas.addEventListener('pointerdown', this._pointerDownHandler);
    }

    this._currentColorWheel = this.shadowRoot.getElementById('colorWheelMini');
    if (this._currentColorWheel) {
      this._currentColorWheel.addEventListener('pointerdown', this._colorWheelPointerDownHandler);
      this._currentColorWheel.addEventListener('pointermove', this._colorWheelPointerMoveHandler);
      this._currentColorWheel.addEventListener('pointerup', this._colorWheelPointerUpHandler);
      this._currentColorWheel.addEventListener('pointercancel', this._colorWheelPointerUpHandler);
    }

    const brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    const temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');

    if (brightnessSlider) {
      brightnessSlider.addEventListener('input', this._brightnessInputHandler);
    }
    if (temperatureSlider) {
      temperatureSlider.addEventListener('input', this._temperatureInputHandler);
    }

    document.addEventListener('click', this._documentClickHandler);
    window.addEventListener('pointermove', this._pointerMoveHandler, { passive: false });
    window.addEventListener('pointerup', this._pointerUpHandler);
    window.addEventListener('pointercancel', this._pointerUpHandler);
  }

  _handleDocumentClick(e) {
    if (!this._settingsOpen || !this.shadowRoot) return;

    const panel = this.shadowRoot.getElementById('settingsPanel');
    const button = this.shadowRoot.getElementById('settingsBtn');
    const path = e.composedPath ? e.composedPath() : [];
    const clickedPanel = panel ? path.includes(panel) : false;
    const clickedButton = button ? path.includes(button) : false;

    if (!clickedPanel && !clickedButton) {
      this._settingsOpen = false;
      this.render();
    }
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!this._currentCanvas) return;

    this._activePointerId = e.pointerId;
    e.target.setPointerCapture?.(e.pointerId);

    const targetLight = e.target.closest('.light');
    if (targetLight) {
      const entity = targetLight.dataset.entity;
      if (!entity) return;

      const rect = this._currentCanvas.getBoundingClientRect();
      const initialLeft = parseFloat(targetLight.style.left) || (this._config.positions[entity]?.x ?? 50);
      const initialTop = parseFloat(targetLight.style.top) || (this._config.positions[entity]?.y ?? 50);

      this._pointerDownLight = {
        entity,
        pointerType: e.pointerType,
        modifier: e.shiftKey || e.ctrlKey || e.metaKey,
        startX: e.clientX,
        startY: e.clientY
      };

      if (!this._lockPositions) {
        this._dragState = {
          entity,
          startX: e.clientX,
          startY: e.clientY,
          initialLeft,
          initialTop,
          canvasRect: rect,
          moved: false
        };
        targetLight.classList.add('dragging');

        if (this._history.length === 0 ||
            JSON.stringify(this._history[this._historyIndex]) !== JSON.stringify(this._config.positions)) {
          this._saveHistory();
        }
      }

      if (e.pointerType === 'touch') {
        if (this._longPressTimer) clearTimeout(this._longPressTimer);
        this._longPressTriggered = false;
        this._longPressTimer = setTimeout(() => {
          this._longPressTriggered = true;
          const alreadySelected = this._selectedLights.has(entity);
          if (alreadySelected) {
            this._selectedLights.delete(entity);
          } else {
            this._selectedLights.add(entity);
          }
          if (navigator.vibrate) navigator.vibrate(40);
          this.render();
          if (this._selectedLights.size > 0) {
            this.drawColorWheel();
          }
        }, 500);
      }

      return;
    }

    if (e.target.id === 'canvas' || e.target.classList.contains('grid')) {
      const rect = this._currentCanvas.getBoundingClientRect();
      this._selectionStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._selectionBox = document.createElement('div');
      this._selectionBox.className = 'selection-box';
      this._currentCanvas.appendChild(this._selectionBox);

      this._selectionAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
      this._selectionBaseline = this._selectionAdditive ? new Set(this._selectedLights) : new Set();

      if (!this._selectionAdditive) {
        this._selectedLights.clear();
        this.updateLights();
      }
    }
  }

  _onPointerMove(e) {
    if (this._activePointerId !== null && e.pointerId !== this._activePointerId) return;

    if (this._longPressTimer && this._pointerDownLight) {
      if (Math.abs(e.clientX - this._pointerDownLight.startX) > 6 ||
          Math.abs(e.clientY - this._pointerDownLight.startY) > 6) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
    }

    if (this._dragState) {
      e.preventDefault();

      const { canvasRect, startX, startY, initialLeft, initialTop, entity } = this._dragState;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        this._dragState.moved = true;
      }

      let newLeft = initialLeft + (deltaX / canvasRect.width) * 100;
      let newTop = initialTop + (deltaY / canvasRect.height) * 100;

      const snapped = this._snapToGrid(newLeft, newTop, e);
      newLeft = Math.max(0, Math.min(100, snapped.x));
      newTop = Math.max(0, Math.min(100, snapped.y));

      const light = this.shadowRoot.querySelector(`[data-entity="${this._dragState.entity}"]`);
      if (light) {
        light.style.left = `${newLeft}%`;
        light.style.top = `${newTop}%`;
      }
      return;
    }

    if (this._selectionBox && this._selectionStart && this._currentCanvas) {
      e.preventDefault();
      const rect = this._currentCanvas.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;
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

  _onPointerUp(e) {
    if (this._activePointerId !== null && e.pointerId !== this._activePointerId) return;

    const dragState = this._dragState;
    if (dragState) {
      const light = this.shadowRoot.querySelector(`[data-entity="${dragState.entity}"]`);
      if (light) {
        light.classList.remove('dragging');
        const finalLeft = parseFloat(light.style.left);
        const finalTop = parseFloat(light.style.top);
        this._config.positions[dragState.entity] = { x: finalLeft, y: finalTop };
      }
      this._dragState = null;
    }

    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    const wasLongPress = this._longPressTriggered;
    this._longPressTriggered = false;

    if (this._pointerDownLight && (!dragState || !dragState.moved) && !wasLongPress) {
      const { entity, modifier } = this._pointerDownLight;
      if (modifier) {
        if (this._selectedLights.has(entity)) {
          this._selectedLights.delete(entity);
        } else {
          this._selectedLights.add(entity);
        }
      } else {
        this._selectedLights.clear();
        this._selectedLights.add(entity);
      }
      this.render();
      if (this._selectedLights.size > 0) {
        this.drawColorWheel();
      }
    }

    this._pointerDownLight = null;
    this._activePointerId = null;

    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
      this._selectionStart = null;
      this.render();
      if (this._selectedLights.size > 0) {
        this.drawColorWheel();
      }
    }

    this._selectionBaseline = new Set();
    this._selectionAdditive = false;
  }

  _selectLightsInBox(left, top, width, height) {
    const canvas = this._currentCanvas || this.shadowRoot.getElementById('canvas');
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const lights = this.shadowRoot.querySelectorAll('.light');
    const selection = new Set(this._selectionBaseline ? Array.from(this._selectionBaseline) : []);

    lights.forEach(light => {
      const lightRect = light.getBoundingClientRect();
      const centerX = lightRect.left - rect.left + lightRect.width / 2;
      const centerY = lightRect.top - rect.top + lightRect.height / 2;

      if (centerX >= left && centerX <= left + width &&
          centerY >= top && centerY <= top + height) {
        selection.add(light.dataset.entity);
      }
    });

    this._selectedLights = selection;

    lights.forEach(light => {
      light.classList.toggle('selected', this._selectedLights.has(light.dataset.entity));
    });
  }

  _handleColorWheelPointer(e, phase) {
    if (!this._currentColorWheel) return;

    if (phase === 'down') {
      if (e.button !== undefined && e.button !== 0) return;
      this._currentColorWheel.setPointerCapture?.(e.pointerId);
      this._activeColorWheelPointer = e.pointerId;
      this._colorWheelActive = true;
      this._handleColorWheelInteraction(e);
    } else if (phase === 'move') {
      if (!this._colorWheelActive || e.pointerId !== this._activeColorWheelPointer) return;
      e.preventDefault();
      this._handleColorWheelInteraction(e);
    } else {
      if (e.pointerId === this._activeColorWheelPointer) {
        this._colorWheelActive = false;
        this._activeColorWheelPointer = null;
      }
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
   * COLOR CONTROL
   */
  _handleColorWheelInteraction(e) {
    const controlledEntities = this._selectedLights.size > 0
      ? Array.from(this._selectedLights)
      : (this._config.default_entity ? [this._config.default_entity] : []);

    if (controlledEntities.length === 0) return;

    const canvas = this._currentColorWheel || this.shadowRoot.getElementById('colorWheelMini');
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : 0);
    const clientY = e.clientY ?? (e.touches ? e.touches[0].clientY : 0);

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

      let background = 'linear-gradient(135deg, #2d2d2d 0%, #171717 100%)';
      if (isOn && state.attributes.rgb_color) {
        const [r, g, b] = state.attributes.rgb_color;
        background = `radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), rgb(${r}, ${g}, ${b})`;
      } else if (isOn && state.attributes.color_temp !== undefined) {
        const kelvin = Math.round(1000000 / state.attributes.color_temp);
        const [r, g, b] = this._kelvinToRGB(kelvin);
        background = `radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), rgb(${r}, ${g}, ${b})`;
      } else if (isOn) {
        background = 'radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.55), transparent 65%), #ffd180';
      }

      const icon = state.attributes.icon
        ? state.attributes.icon
        : (isOn ? 'mdi:lightbulb-on' : 'mdi:lightbulb-outline');
      const iconColor = isOn ? '#0f0f0f' : 'rgba(255, 255, 255, 0.65)';

      light.style.background = background;
      light.style.setProperty('--light-icon-color', iconColor);
      light.classList.toggle('off', !isOn);
      light.classList.toggle('on', isOn);

      const iconEl = light.querySelector('.light-icon');
      if (iconEl) {
        iconEl.setAttribute('icon', icon);
        iconEl.style.color = iconColor;
      }
    });

    // Update control values if controls are visible
    if (this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) {
      const avgState = this._getAverageState();
      this._updateControlValues(avgState);
      this._updateSliderVisuals(avgState);
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
