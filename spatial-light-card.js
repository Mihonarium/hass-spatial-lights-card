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

    this.shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        
        :host {
          --bg-primary: #0d0d0d;
          --bg-secondary: #1a1a1a;
          --text-primary: rgba(255, 255, 255, 0.95);
          --text-secondary: rgba(255, 255, 255, 0.6);
          --text-tertiary: rgba(255, 255, 255, 0.35);
          --border-subtle: rgba(255, 255, 255, 0.08);
          --selection-glow: rgba(100, 150, 255, 0.4);
          --grid-dots: rgba(255, 255, 255, 0.04);
        }
        
        ha-card {
          background: var(--bg-primary);
          overflow: hidden;
        }

        /* HEADER - Minimal */
        .header {
          padding: 16px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--border-subtle);
        }

        .title {
          font-size: 16px;
          font-weight: 500;
          color: var(--text-secondary);
          margin: 0;
          letter-spacing: 0.3px;
        }

        .settings-btn {
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          border-radius: 6px;
          cursor: pointer;
          font-size: 18px;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .settings-btn:hover {
          background: var(--bg-secondary);
          color: var(--text-secondary);
        }

        /* CANVAS - The Hero */
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

        /* Subtle grid - always visible but quiet */
        .grid {
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, var(--grid-dots) 1px, transparent 1px);
          background-size: ${this._gridSize}px ${this._gridSize}px;
          pointer-events: none;
          opacity: 1;
        }

        /* LIGHT ORBS - Clean, minimal */
        .light {
          position: absolute;
          width: 52px;
          height: 52px;
          border-radius: 50%;
          transform: translate(-50%, -50%);
          cursor: ${this._lockPositions ? 'pointer' : 'grab'};
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                      box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* Light appearance based on state */
        .light::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: inherit;
          box-shadow: 
            0 4px 16px rgba(0, 0, 0, 0.3),
            inset 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        /* Subtle glow when on */
        .light.on::after {
          content: '';
          position: absolute;
          inset: -8px;
          border-radius: 50%;
          background: inherit;
          filter: blur(12px);
          opacity: 0.3;
          z-index: -1;
        }

        /* Off state - subtle gray */
        .light.off {
          background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%) !important;
          opacity: 0.5;
        }

        .light.off::after {
          display: none;
        }

        /* Hover - show label */
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

        /* Selection - soft glow */
        .light.selected {
          z-index: 10;
        }

        .light.selected::before {
          box-shadow: 
            0 0 0 2px rgba(255, 255, 255, 0.5),
            0 0 0 4px var(--selection-glow),
            0 4px 16px rgba(0, 0, 0, 0.3),
            inset 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        /* Dragging */
        .light.dragging {
          cursor: grabbing;
          z-index: 100;
          transform: translate(-50%, -50%) scale(1.05);
        }

        /* Selection box */
        .selection-box {
          position: absolute;
          border: 1px solid var(--selection-glow);
          background: rgba(100, 150, 255, 0.08);
          pointer-events: none;
          border-radius: 2px;
        }

        /* FLOATING CONTROLS - Contextual */
        .controls-floating {
          position: absolute;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(26, 26, 26, 0.95);
          backdrop-filter: blur(20px);
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          padding: 16px 20px;
          display: flex;
          gap: 20px;
          align-items: center;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
          z-index: 50;
        }

        .controls-floating.visible {
          opacity: 1;
          pointer-events: auto;
        }

        /* CONTROLS BELOW CANVAS - Always visible variant */
        .controls-below {
          padding: 20px;
          border-top: 1px solid var(--border-subtle);
          background: var(--bg-primary);
          display: ${showControls ? 'flex' : 'none'};
          gap: 24px;
          align-items: center;
          justify-content: center;
        }

        /* Color picker */
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

        /* Sliders */
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
        }

        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
        }

        .slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: white;
          cursor: pointer;
          border: none;
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

        /* SETTINGS PANEL */
        .settings-panel {
          position: absolute;
          top: 60px;
          right: 20px;
          background: rgba(26, 26, 26, 0.98);
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
          background: rgba(100, 150, 255, 0.6);
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

        /* YAML MODAL */
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

        /* Responsive */
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
          <div class="title">${this._config.title}</div>
          ${this._config.show_settings_button ? `
            <button class="settings-btn" id="settingsBtn" aria-label="Settings">⚙</button>
          ` : ''}
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
      
      let color = '#2a2a2a';
      if (isOn && state.attributes.rgb_color) {
        const [r, g, b] = state.attributes.rgb_color;
        color = `rgb(${r}, ${g}, ${b})`;
      } else if (isOn) {
        color = '#ffa500';
      }

      return `
        <div 
          class="light ${isOn ? 'on' : 'off'} ${isSelected ? 'selected' : ''}"
          style="left: ${pos.x}%; top: ${pos.y}%; background: ${color};"
          data-entity="${entity_id}"
          tabindex="0"
          role="button"
          aria-label="${state.attributes.friendly_name}"
          aria-pressed="${isSelected}"
        >
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
    if (this._boundGlobalMouseUp) {
      document.removeEventListener('mouseup', this._boundGlobalMouseUp);
      document.removeEventListener('touchend', this._boundGlobalMouseUp);
    }
    if (this._boundGlobalMouseMove) {
      document.removeEventListener('mousemove', this._boundGlobalMouseMove);
      document.removeEventListener('touchmove', this._boundGlobalMouseMove);
    }
    if (this._boundKeyDown) {
      document.removeEventListener('keydown', this._boundKeyDown);
    }
  }

  _attachEventListeners() {
    // Settings button
    const settingsBtn = this.shadowRoot.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._settingsOpen = !this._settingsOpen;
        this.render();
      });
    }

    // Close settings when clicking outside
    const closeSettings = (e) => {
      if (this._settingsOpen && 
          !e.target.closest('.settings-panel') && 
          !e.target.closest('.settings-btn')) {
        this._settingsOpen = false;
        this.render();
      }
    };
    document.addEventListener('click', closeSettings);

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
      });
      light.addEventListener('touchend', (e) => {
        this._handleLightTouchEnd(e, light);
      });
    });

    // Canvas for selection box
    const canvas = this.shadowRoot.getElementById('canvas');
    if (canvas) {
      canvas.addEventListener('mousedown', (e) => this._handleCanvasMouseDown(e));
      canvas.addEventListener('touchstart', (e) => this._handleCanvasTouchStart(e));
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
      
      let color = '#2a2a2a';
      if (isOn && state.attributes.rgb_color) {
        const [r, g, b] = state.attributes.rgb_color;
        color = `rgb(${r}, ${g}, ${b})`;
      } else if (isOn) {
        color = '#ffa500';
      }

      light.style.background = isOn ? color : 'linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%)';
      light.classList.toggle('off', !isOn);
      light.classList.toggle('on', isOn);
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
