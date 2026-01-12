class SpatialLightColorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** Core state */
    this._config = {};
    this._hass = null;

    /** Selection & interactions */
    this._selectedLights = new Set();
    this._dragState = null;             // { entity, startX, startY, initialLeft, initialTop, rect, moved }
    this._selectionBox = null;          // HTMLElement for rubberband selection
    this._selectionStart = null;        // { x, y } in canvas coords
    this._selectionModeAdditive = false;
    this._selectionBase = null;

    /** UI state */
    this._settingsOpen = false;
    this._yamlModalOpen = false;

    /** History (positions undo/redo) */
    this._history = [];
    this._historyIndex = -1;

    /** Pending user inputs (debounced applies) */
    this._pendingBrightness = null;
    this._pendingTemperature = null;
    this._pendingColor = null;

    /** Settings */
    this._lightSize = 56;
    this._gridSize = 25;
    this._snapOnModifier = true;  // if true, requires Alt key to snap
    this._lockPositions = true;
    this._iconRefreshHandle = null;
    this._iconRehydrateHandle = null;

    /** Animation frame / batching */
    this._raf = null;
    this._colorWheelActive = false;
    this._colorWheelObserver = null;
    this._colorWheelFrame = null;
    this._colorWheelLastSize = null;
    this._colorWheelCancel = null;
    this._colorWheelGesture = null;    // { pointerId, isTouch, startScroll: {x,y}, scrolled, pendingColor }

    /** Cached DOM refs (stable after first render) */
    this._els = {
      canvas: null,
      controlsFloating: null,
      controlsBelow: null,
      brightnessSlider: null,
      brightnessValue: null,
      temperatureSlider: null,
      temperatureValue: null,
      colorWheel: null,
      settingsBtn: null,
      settingsPanel: null,
      lockToggle: null,
      iconToggle: null,
      iconOnlyToggle: null,
      switchTapToggle: null,
      rearrangeBtn: null,
      exportBtn: null,
      yamlModal: null,
      yamlOutput: null,
      lightSizeSlider: null,
      lightSizeValue: null,
    };

    /** Global bindings */
    this._boundKeyDown = null;
    this._boundCloseSettings = null;
    this._boundIconsetAdded = null;
    this._boundMoreInfo = null;

    /** Touch affordances */
    this._longPressTimer = null;
    this._longPressTriggered = false;
    this._pendingTap = null;
    this._lastTap = null;

    /** Overlay coordination */
    this._moreInfoOpen = false;
  }

  /** Home Assistant integration */
  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities)) {
      throw new Error('You must specify entities as an array');
    }

    const normalizedPositions = {};
    if (config.positions && typeof config.positions === 'object') {
      Object.entries(config.positions).forEach(([entity, pos]) => {
        if (!pos || typeof pos !== 'object') return;
        const x = typeof pos.x === 'number' ? pos.x : parseFloat(pos.x);
        const y = typeof pos.y === 'number' ? pos.y : parseFloat(pos.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          normalizedPositions[entity] = { x, y };
        }
      });
    }

    let tempMin = null;
    let tempMax = null;
    if (Array.isArray(config.temperature_range) && config.temperature_range.length === 2) {
      const [minVal, maxVal] = config.temperature_range;
      tempMin = typeof minVal === 'number' ? minVal : parseFloat(minVal);
      tempMax = typeof maxVal === 'number' ? maxVal : parseFloat(maxVal);
    } else if (config.temperature_range && typeof config.temperature_range === 'object') {
      const { min, max } = config.temperature_range;
      tempMin = typeof min === 'number' ? min : parseFloat(min);
      tempMax = typeof max === 'number' ? max : parseFloat(max);
    }
    if (config.temperature_min != null && !Number.isNaN(parseFloat(config.temperature_min))) {
      tempMin = parseFloat(config.temperature_min);
    }
    if (config.temperature_max != null && !Number.isNaN(parseFloat(config.temperature_max))) {
      tempMax = parseFloat(config.temperature_max);
    }

    const backgroundImage = this._normalizeBackgroundImage(config.background_image);
    const lightSize = this._normalizeLightSize(config.light_size);

    this._config = {
      entities: config.entities,
      positions: normalizedPositions,
      title: config.title || '',
      canvas_height: config.canvas_height || 450,
      grid_size: config.grid_size || 25,
      label_mode: config.label_mode || 'smart',
      label_overrides: config.label_overrides || {},
      show_settings_button: config.show_settings_button !== false,
      always_show_controls: config.always_show_controls || false,
      default_entity: config.default_entity || null,
      controls_below: config.controls_below !== false,
      show_entity_icons: config.show_entity_icons || false,
      switch_single_tap: config.switch_single_tap || false,
      icon_style: config.icon_style || 'mdi', // 'mdi' or 'emoji' (emoji kept as fallback only)
      icon_only: !!config.icon_only,
      light_size: lightSize,
      temperature_min: Number.isFinite(tempMin) ? tempMin : null,
      temperature_max: Number.isFinite(tempMax) ? tempMax : null,
      background_image: backgroundImage,
      
      // Color customization
      switch_on_color: config.switch_on_color || '#ffa500',
      switch_off_color: config.switch_off_color || '#2a2a2a',
      scene_color: config.scene_color || '#6366f1',
      color_overrides: config.color_overrides || {},
    };

    this._lightSize = lightSize;
    this._gridSize = this._config.grid_size;
    this._applyLightSize(lightSize);
    this._initializePositions();
  }

  _normalizeBackgroundImage(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const url = value.trim();
      return url ? { url } : null;
    }
    if (typeof value === 'object') {
      const url = typeof value.url === 'string' ? value.url.trim() : '';
      const size = typeof value.size === 'string' ? value.size.trim() : '';
      const position = typeof value.position === 'string' ? value.position.trim() : '';
      const repeat = typeof value.repeat === 'string' ? value.repeat.trim() : '';
      const blend = typeof value.blend_mode === 'string' ? value.blend_mode.trim() : '';
      if (!url && !size && !position && !repeat && !blend) return null;
      const normalized = {};
      if (url) normalized.url = url;
      if (size) normalized.size = size;
      if (position) normalized.position = position;
      if (repeat) normalized.repeat = repeat;
      if (blend) normalized.blend_mode = blend;
      return normalized;
    }
    return null;
  }

  _normalizeLightSize(value) {
    const num = Number.isFinite(value) ? value : parseFloat(value);
    if (!Number.isFinite(num)) return 56;
    return Math.min(120, Math.max(32, Math.round(num)));
  }

  _canvasBackgroundStyle() {
    const bg = this._config.background_image;
    if (!bg) return '';
    const vars = [];
    if (bg.url) {
      const escaped = String(bg.url).replace(/"/g, '%22').replace(/'/g, "\\'");
      vars.push(`--canvas-background-image:url('${escaped}')`);
    }
    if (bg.size) vars.push(`--canvas-background-size:${bg.size}`);
    if (bg.position) vars.push(`--canvas-background-position:${bg.position}`);
    if (bg.repeat) vars.push(`--canvas-background-repeat:${bg.repeat}`);
    if (bg.blend_mode) vars.push(`--canvas-background-blend-mode:${bg.blend_mode}`);
    return vars.join('; ');
  }

  set hass(hass) {
    const firstTime = !this._hass;
    this._hass = hass;
    if (firstTime) {
      this._renderAll();
    } else {
      this.updateLights();
    }
  }

  /** ---------- Label system ---------- */
  _generateLabel(entity_id) {
    if (this._config.label_overrides[entity_id]) {
      return this._config.label_overrides[entity_id];
    }
    const st = this._hass?.states[entity_id];
    if (!st) return '?';

    const name = st.attributes.friendly_name || entity_id;
    const allNames = this._config.entities.map(e => this._hass?.states[e]?.attributes.friendly_name || e);

    // 1) trailing numbers
    const m = name.match(/(\d+)$/);
    if (m) {
      const base = name.substring(0, name.length - m[0].length).trim();
      const n = m[0];
      const similar = allNames.filter(nm => nm.startsWith(base)).length;
      if (similar > 1) {
        return this._getInitials(base) + n;
      }
    }
    // 2) directional
    const words = name.split(/\s+/);
    const dirs = ['left', 'right', 'center', 'front', 'back', 'top', 'bottom', 'north', 'south', 'east', 'west'];
    const dirWord = words.find(w => dirs.includes(w.toLowerCase()));
    if (dirWord) {
      const baseWords = words.filter(w => w !== dirWord);
      const initials = baseWords.slice(0, 2).map(w => w[0]).join('');
      return (initials + dirWord[0]).toUpperCase();
    }
    return this._getInitials(name);
  }

  _getInitials(text) {
    const stop = ['the', 'a', 'an', 'light', 'lamp', 'bulb'];
    const ws = text.split(/\s+/).filter(w => w && !stop.includes(w.toLowerCase()));
    if (ws.length === 0) return text.substring(0, 2).toUpperCase();
    if (ws.length === 1) return ws[0].substring(0, 2).toUpperCase();
    return ws.slice(0, 3).map(w => w[0]).join('').toUpperCase();
  }

  /** ---------- Icon system (SVG via HA components) ---------- */
  _getEntityIconData(entity_id) {
    const st = this._hass?.states[entity_id];
    if (!st) {
      if (entity_id.startsWith('scene.')) return { type: 'mdi', value: 'mdi:palette' };
      return { type: 'mdi', value: 'mdi:lightbulb' };
    }
    const icon = st.attributes.icon || (entity_id.startsWith('scene.') ? 'mdi:palette' : 'mdi:lightbulb');
    if (this._config.icon_style === 'emoji') {
      // Fallback only; discouraged in this upgrade
      return { type: 'emoji', value: '💡' };
    }
    if (icon.startsWith('mdi:')) return { type: 'mdi', value: icon };
    // HA sometimes sets arbitrary icon strings; attempt to feed into ha-icon anyway
    return { type: 'mdi', value: icon };
  }

  _renderIcon(iconData) {
    if (iconData.type === 'mdi') {
      return `<ha-icon class="light-icon light-icon-mdi" data-icon="${iconData.value}" icon="${iconData.value}"></ha-icon>`;
    }
    if (iconData.type === 'emoji') {
      return `<div class="light-icon light-icon-emoji">${iconData.value}</div>`;
    }
    return `<ha-icon class="light-icon light-icon-mdi" data-icon="mdi:lightbulb" icon="mdi:lightbulb"></ha-icon>`;
  }

  _scheduleIconRefresh(attempt, delay) {
    if (this._iconRefreshHandle) {
      clearTimeout(this._iconRefreshHandle);
    }
    this._iconRefreshHandle = setTimeout(() => {
      this._iconRefreshHandle = null;
      this._refreshEntityIcons(attempt);
    }, delay);
  }

  _refreshEntityIcons(attempt = 0) {
    if (!this.shadowRoot) return;
    const icons = this.shadowRoot.querySelectorAll('ha-icon[data-icon]');
    if (!icons.length) return;

    const applyIcons = () => {
      icons.forEach(iconEl => {
        const iconName = iconEl.getAttribute('data-icon');
        if (!iconName) return;
        if (iconEl.icon !== iconName) {
          iconEl.icon = iconName;
        }
        if (iconEl.getAttribute('icon') !== iconName) {
          iconEl.setAttribute('icon', iconName);
        }
        if (this._hass && iconEl.hass !== this._hass) {
          iconEl.hass = this._hass;
        }
      });
    };

    const ensureDefined = () => {
      applyIcons();
      const unresolved = Array.from(icons).some(iconEl => {
        if (!iconEl.shadowRoot) return true;
        return !iconEl.shadowRoot.querySelector('ha-svg-icon, svg');
      });
      if (unresolved && attempt < 8) {
        this._scheduleIconRefresh(attempt + 1, 250 * (attempt + 1));
        if (!this._iconRehydrateHandle) {
          this._iconRehydrateHandle = setTimeout(() => {
            this._iconRehydrateHandle = null;
            this._forceIconRerender();
          }, 120);
        }
      } else if (!unresolved && this._iconRehydrateHandle) {
        clearTimeout(this._iconRehydrateHandle);
        this._iconRehydrateHandle = null;
      }
    };

    if (typeof customElements === 'undefined') {
      ensureDefined();
      return;
    }

    if (customElements.get('ha-icon')) {
      ensureDefined();
    } else if (attempt < 8) {
      customElements.whenDefined('ha-icon').then(() => this._refreshEntityIcons(attempt + 1));
    }
  }

  _forceIconRerender() {
    if (!this.shadowRoot) return;
    const lights = this.shadowRoot.querySelectorAll('.light');
    if (!lights.length) return;

    lights.forEach(light => {
      const existing = light.querySelector('ha-icon[data-icon]');
      if (!existing) return;
      const iconName = existing.getAttribute('data-icon');
      if (!iconName) return;
      const replacement = document.createElement('ha-icon');
      replacement.className = existing.className;
      replacement.setAttribute('data-icon', iconName);
      replacement.setAttribute('icon', iconName);
      if (this._hass) {
        replacement.hass = this._hass;
      }
      light.replaceChild(replacement, existing);
    });

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    raf(() => this._refreshEntityIcons());
  }

  _toggleEntity(entity) {
    if (!this._hass) return;
    const stateObj = this._hass.states?.[entity];
    if (!stateObj) return;
    const [domain] = entity.split('.');
    
    if (domain === 'scene') {
      this._hass.callService('scene', 'turn_on', { entity_id: entity });
      return;
    }

    if (domain !== 'light' && domain !== 'switch' && domain !== 'input_boolean') return;
    const service = stateObj.state === 'on' ? 'turn_off' : 'turn_on';
    this._hass.callService(domain, service, { entity_id: entity });
  }

  _openMoreInfo(entity) {
    this._moreInfoOpen = true;
    this._syncOverlayState();
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId: entity },
      bubbles: true,
      composed: true,
    }));
  }

  /** ---------- Auto-layout / rearrange ---------- */
  _initializePositions() {
    const unpos = this._config.entities.filter(e => !this._config.positions[e]);
    if (unpos.length === 0) return;

    const cols = Math.ceil(Math.sqrt(unpos.length * 1.5));
    const rows = Math.ceil(unpos.length / cols);
    const spacing = 100 / (cols + 1);

    unpos.forEach((entity, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      this._config.positions[entity] = {
        x: spacing * (col + 1),
        y: (100 / (rows + 1)) * (row + 1),
      };
    });
  }

  _rearrangeAllLights() {
    // Cancel any active interactions first
    this._cancelActiveInteractions();

    const entities = this._config.entities;
    const cols = Math.ceil(Math.sqrt(entities.length * 1.5));
    const rows = Math.ceil(entities.length / cols);
    const spacing = 100 / (cols + 1);

    const previousPositions = this._clonePositions();
    const newPositions = {};
    entities.forEach((entity, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const pos = {
        x: spacing * (col + 1),
        y: (100 / (rows + 1)) * (row + 1),
      };
      newPositions[entity] = pos;
    });

    this._config.positions = newPositions;
    this._saveHistory(previousPositions);
    this._saveHistory(newPositions);
    this._smoothApplyPositions();
    this.updateLights();
  }

  _smoothApplyPositions() {
    // Smoothly transition existing DOM nodes instead of full re-render
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const entity = light.dataset.entity;
      const pos = this._config.positions[entity];
      if (pos) {
        light.style.transition = 'left 200ms ease, top 200ms ease';
        light.style.left = `${pos.x}%`;
        light.style.top = `${pos.y}%`;
        // Remove transition after complete to avoid future lag
        setTimeout(() => {
          if (light) light.style.transition = '';
        }, 250);
      }
    });
    // Controls may rely on selection state; keep as-is.
  }

  /** ---------- History ---------- */
  _saveHistory(snapshot = null) {
    const snapshotPositions = this._clonePositions(snapshot || this._config.positions);
    const last = this._history[this._historyIndex];
    if (last && JSON.stringify(last) === JSON.stringify(snapshotPositions)) return;

    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(snapshotPositions);
    if (this._history.length > 50) {
      this._history.shift();
      this._historyIndex = this._history.length - 1;
    } else {
      this._historyIndex++;
    }
  }
  _undo() {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._config.positions = this._clonePositions(this._history[this._historyIndex]);
      this._smoothApplyPositions();
    }
  }
  _redo() {
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._config.positions = this._clonePositions(this._history[this._historyIndex]);
      this._smoothApplyPositions();
    }
  }

  /** ---------- Grid snap ---------- */
  _shouldSnap(event) {
    return event?.altKey || !this._snapOnModifier;
  }
  _snapToGrid(x, y, event) {
    if (!this._shouldSnap(event)) return { x, y };
    const canvas = this._els.canvas;
    if (!canvas) return { x, y };
    const rect = canvas.getBoundingClientRect();
    const px = (x / 100) * rect.width;
    const py = (y / 100) * rect.height;
    const sx = Math.round(px / this._gridSize) * this._gridSize;
    const sy = Math.round(py / this._gridSize) * this._gridSize;
    return { x: (sx / rect.width) * 100, y: (sy / rect.height) * 100 };
  }

  /** ---------- Aggregated state of selected lights ---------- */
  _getControlledEntities() {
    if (this._selectedLights.size > 0) {
      return [...this._selectedLights];
    }
    if (this._config.default_entity) {
      return [this._config.default_entity];
    }
    return [];
  }

  _clampTemperature(value, range) {
    if (!range) return value;
    return Math.max(range.min, Math.min(range.max, value));
  }

  _clonePositions(source = this._config.positions) {
    return JSON.parse(JSON.stringify(source || {}));
  }

  _resolveTemperatureRange(controlled) {
    const explicitMin = Number.isFinite(this._config.temperature_min) ? this._config.temperature_min : null;
    const explicitMax = Number.isFinite(this._config.temperature_max) ? this._config.temperature_max : null;

    let minK = explicitMin ?? Infinity;
    let maxK = explicitMax ?? -Infinity;

    const pool = (controlled && controlled.length > 0) ? controlled : this._config.entities;

    pool.forEach(entity_id => {
      const st = this._hass?.states?.[entity_id];
      if (!st) return;
      const attrs = st.attributes || {};

      const maxMireds = attrs.max_mireds != null ? Number(attrs.max_mireds) : NaN;
      const minMireds = attrs.min_mireds != null ? Number(attrs.min_mireds) : NaN;
      if (Number.isFinite(maxMireds) && Number.isFinite(minMireds)) {
        const warm = Math.round(1000000 / maxMireds);
        const cool = Math.round(1000000 / minMireds);
        minK = Math.min(minK, warm);
        maxK = Math.max(maxK, cool);
        return;
      }

      const colorTempKelvin = attrs.color_temp_kelvin != null ? Number(attrs.color_temp_kelvin) : NaN;
      if (Number.isFinite(colorTempKelvin)) {
        const current = Math.round(colorTempKelvin);
        minK = Math.min(minK, current);
        maxK = Math.max(maxK, current);
        return;
      }

      const colorTempMired = attrs.color_temp != null ? Number(attrs.color_temp) : NaN;
      if (Number.isFinite(colorTempMired)) {
        const current = Math.round(1000000 / colorTempMired);
        minK = Math.min(minK, current);
        maxK = Math.max(maxK, current);
      }
    });

    if (!Number.isFinite(minK)) minK = explicitMin ?? 2000;
    if (!Number.isFinite(maxK)) maxK = explicitMax ?? 6500;

    if (explicitMin != null) minK = explicitMin;
    if (explicitMax != null) maxK = explicitMax;

    minK = Math.max(1000, Math.round(minK));
    maxK = Math.min(10000, Math.round(maxK));

    if (minK >= maxK) {
      const base = Math.max(1000, Math.round((minK + maxK) / 2) || 3000);
      minK = Math.max(1000, base - 100);
      maxK = Math.max(minK + 100, base + 100);
    }

    return { min: minK, max: maxK };
  }

  _getControlContext() {
    const controlled = this._getControlledEntities();

    let bTot = 0, bCnt = 0;
    let tTot = 0, tCnt = 0;
    let lastRGB = null;

    controlled.forEach(id => {
      const st = this._hass?.states?.[id];
      if (!st || st.state !== 'on') return;
      if (st.attributes.brightness != null) {
        bTot += st.attributes.brightness; bCnt++;
      }
      if (st.attributes.color_temp != null) {
        const kelvin = Math.round(1000000 / st.attributes.color_temp);
        tTot += kelvin; tCnt++;
      }
      if (Array.isArray(st.attributes.rgb_color)) {
        lastRGB = st.attributes.rgb_color;
      }
    });

    const range = this._resolveTemperatureRange(controlled);

    const avgBrightness = bCnt ? Math.round(bTot / bCnt) : 128;
    const avgTemperatureRaw = tCnt ? Math.round(tTot / tCnt) : Math.round((range.min + range.max) / 2);
    const avgTemperature = this._clampTemperature(avgTemperatureRaw, range);

    return {
      controlled,
      avgState: {
        brightness: avgBrightness,
        temperature: avgTemperature,
        color: lastRGB,
      },
      tempRange: range,
    };
  }

  /** ---------- Rendering ---------- */
  _renderAll() {
    const controlContext = this._getControlContext();
    const avgState = controlContext.avgState;
    const showControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    const controlsPosition = this._config.controls_below ? 'below' : 'floating';
    const showHeader = this._config.title || this._config.show_settings_button;

    this.shadowRoot.innerHTML = `
      <style>
        ${this._styles()}
      </style>
      <ha-card>
        ${showHeader ? this._renderHeader() : ''}
        <div class="canvas-wrapper">
          <div class="canvas" id="canvas" role="application" aria-label="Spatial light control area" style="${this._canvasBackgroundStyle()}">
            <div class="grid"></div>
            ${this._renderLightsHTML()}
            ${controlsPosition === 'floating' ? this._renderControlsFloating(showControls, controlContext) : ''}
            ${this._renderSettings()}
          </div>
          ${controlsPosition === 'below' ? this._renderControlsBelow(controlContext) : ''}
        </div>
        ${this._renderYamlModal()}
      </ha-card>
    `;

    // Cache refs once
    this._els.canvas = this.shadowRoot.getElementById('canvas');
    this._els.controlsFloating = this.shadowRoot.getElementById('controlsFloating');
    this._els.controlsBelow = this.shadowRoot.getElementById('controlsBelow');
    this._els.brightnessSlider = this.shadowRoot.getElementById('brightnessSlider');
    this._els.brightnessValue = this.shadowRoot.getElementById('brightnessValue');
    this._els.temperatureSlider = this.shadowRoot.getElementById('temperatureSlider');
    this._els.temperatureValue = this.shadowRoot.getElementById('temperatureValue');
    this._els.colorWheel = this.shadowRoot.getElementById('colorWheelMini');
    this._els.settingsBtn = this.shadowRoot.getElementById('settingsBtn');
    this._els.settingsPanel = this.shadowRoot.getElementById('settingsPanel');
    this._els.lockToggle = this.shadowRoot.getElementById('lockToggle');
    this._els.iconToggle = this.shadowRoot.getElementById('iconToggle');
    this._els.iconOnlyToggle = this.shadowRoot.getElementById('iconOnlyToggle');
    this._els.switchTapToggle = this.shadowRoot.getElementById('switchTapToggle');
    this._els.rearrangeBtn = this.shadowRoot.getElementById('rearrangeBtn');
    this._els.exportBtn = this.shadowRoot.getElementById('exportBtn');
    this._els.yamlModal = this.shadowRoot.getElementById('yamlModal');
    this._els.yamlOutput = this.shadowRoot.getElementById('yamlOutput');
    this._els.lightSizeSlider = this.shadowRoot.getElementById('lightSizeSlider');
    this._els.lightSizeValue = this.shadowRoot.getElementById('lightSizeValue');

    this._applyLightSize(this._config.light_size);

    if (this._colorWheelObserver) {
      this._colorWheelObserver.disconnect();
      this._colorWheelObserver = null;
    }
    if (this._els.colorWheel && typeof window !== 'undefined' && 'ResizeObserver' in window) {
      this._colorWheelObserver = new ResizeObserver(() => {
        this._requestColorWheelDraw(true);
      });
      this._colorWheelObserver.observe(this._els.colorWheel);
    }

    this._attachEventListeners();
    if ((showControls || this._config.always_show_controls) && this._els.colorWheel) {
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
      raf(() => {
        this._requestColorWheelDraw(true);
      });
      this._updateControlValues(controlContext);
    }
    this._syncOverlayState();
    this.updateLights();
    this._refreshEntityIcons();
  }

  _styles() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      :host {
        --surface-primary: #0a0a0a;
        --surface-secondary: #141414;
        --surface-tertiary: #1a1a1a;
        --surface-elevated: #1f1f1f;

        --text-primary: #ffffff;
        --text-secondary: rgba(255,255,255,0.7);
        --text-tertiary: rgba(255,255,255,0.45);

        --border-subtle: rgba(255,255,255,0.06);
        --border-medium: rgba(255,255,255,0.12);

        --accent-primary: #6366f1;

        --grid-dots: rgba(255,255,255,0.035);

        --shadow-sm: 0 1px 2px rgba(0,0,0,0.35);
        --shadow-md: 0 4px 8px rgba(0,0,0,0.45);

        --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;

        --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-full: 9999px;

        --transition-fast: 120ms cubic-bezier(0.4,0,0.2,1);
        --transition-base: 200ms cubic-bezier(0.4,0,0.2,1);

        --light-size: ${this._config.light_size}px;
        --light-size-mobile: clamp(32px, calc(var(--light-size) - 6px), 120px);
        --light-icon-size: calc(var(--light-size) * 0.42);
        --light-icon-color: rgba(255,255,255,0.92);
      }
      @media (prefers-reduced-motion: reduce) {
        :host { --transition-fast: 0ms; --transition-base: 0ms; }
        * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
      }
      ha-card {
        background: var(--surface-primary);
        overflow: hidden;
        font-family: var(--font-sans);
        position: relative;
        z-index: 0;
      }

      .header {
        padding: 16px 20px; display: flex; justify-content: space-between; align-items: center;
        border-bottom: 1px solid var(--border-subtle); background: var(--surface-secondary);
      }
      .title { font-size: 14px; font-weight: 600; color: var(--text-secondary); letter-spacing: -0.01em; }
      .settings-btn {
        width: 32px; height: 32px; border: none; background: transparent; color: var(--text-tertiary);
        border-radius: var(--radius-sm); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center;
        transition: transform var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
      }
      .settings-btn:hover { background: var(--surface-tertiary); color: var(--text-secondary); transform: rotate(24deg); }
      .settings-btn:active { transform: rotate(24deg) scale(0.96); }
      .settings-btn:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

      .canvas-wrapper { position: relative; }
      .canvas {
        position: relative; width: 100%; height: ${this._config.canvas_height}px; background: var(--surface-primary);
        background-image: var(--canvas-background-image, none);
        background-size: var(--canvas-background-size, cover);
        background-position: var(--canvas-background-position, center);
        background-repeat: var(--canvas-background-repeat, no-repeat);
        background-blend-mode: var(--canvas-background-blend-mode, normal);
        overflow: hidden; user-select: none; touch-action: none;
      }
      .grid {
        position: absolute; inset: 0;
        background-image: radial-gradient(circle, var(--grid-dots) 1px, transparent 1px);
        background-size: ${this._gridSize}px ${this._gridSize}px; pointer-events: none;
      }

      .light {
        position: absolute; width: var(--light-size); height: var(--light-size); border-radius: var(--radius-full);
        transform: translate(-50%,-50%); cursor: ${this._lockPositions ? 'pointer' : 'grab'};
        display:flex; align-items:center; justify-content:center; flex-direction:column;
        will-change: transform, left, top, background; z-index: 1;
      }
      .light::before { content:''; position:absolute; inset:0; border-radius:inherit; background:inherit; box-shadow: var(--shadow-sm); }
      .light.on::after {
        content:''; position:absolute; inset:-6px; border-radius:inherit; background:inherit; filter: blur(10px);
        opacity: 0.22; z-index: -1;
      }
      /* Remove forced gradient, allow JS to override background if needed */
      .light.off { opacity: 0.45; }
      .light.off:not([style*="background"]) { background: linear-gradient(135deg,#2a2a2a 0%, #1a1a1a 100%); }
      .light.off::after { display:none; }

      .light-icon-emoji { font-size: calc(var(--light-icon-size) * 0.95); line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); color: var(--light-icon-color); }
      .light-icon-mdi { --mdc-icon-size: var(--light-icon-size); color: var(--light-icon-color); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); }

      .light-label {
        position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
        padding: 4px 8px; background: var(--surface-elevated); color: var(--text-primary);
        font-size: 11px; font-weight: 600; border-radius: var(--radius-sm); white-space: nowrap; pointer-events: none;
        opacity: 0; transition: opacity var(--transition-fast); z-index: 5; border: 1px solid var(--border-subtle);
      }
      .light:hover .light-label { opacity: 1; }

      .light.selected { z-index: 3; }
      .light.selected::before {
        box-shadow: 0 0 0 2px var(--surface-primary), 0 0 0 4px rgba(99,102,241,0.5), var(--shadow-md);
      }
      .light.dragging { cursor: grabbing; z-index: 6; transform: translate(-50%,-50%) scale(1.04); }

      .light.icon-only {
        background: transparent !important;
        --light-icon-size: calc(var(--light-size) * 0.68);
      }
      .light.icon-only::before {
        background: transparent !important;
        border: 1px solid var(--border-medium);
        box-shadow: none;
      }
      .light.icon-only::after { display: none; }
      .light.icon-only.off { opacity: 0.7; }
      .light.icon-only.selected::before {
        box-shadow: 0 0 0 2px var(--surface-primary), 0 0 0 4px rgba(99,102,241,0.5), var(--shadow-md);
      }

      .selection-box {
        position: absolute; border: 1.5px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.08);
        border-radius: 8px; pointer-events: none; backdrop-filter: blur(2px);
      }

      .controls-floating {
        position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(20,20,20,0.95); backdrop-filter: blur(16px) saturate(160%);
        border: 1px solid var(--border-medium); border-radius: 12px; padding: 16px 20px;
        display: flex; gap: 20px; align-items: center; box-shadow: var(--shadow-md);
        opacity: 0; pointer-events: none; transition: opacity var(--transition-base);
        z-index: 50;
      }
      .controls-floating.visible { opacity: 1; pointer-events: auto; }

      .controls-below {
        padding: 20px; border-top: 1px solid var(--border-subtle); background: var(--surface-secondary);
        display: none;
        gap: 24px; align-items: center; justify-content: center;
      }
      .controls-below.visible { display: flex; }

      .color-wheel-mini {
        width: 128px; height: 128px; border-radius: 9999px; cursor: pointer;
        border: 2px solid var(--border-subtle); box-shadow: var(--shadow-sm); flex-shrink: 0;
      }

      .slider-group { display:flex; flex-direction:column; gap:10px; min-width: 240px; flex:1; width:100%; }
      .slider-row { display:flex; align-items:center; gap:8px; width:100%; padding: 2px 0; }

      .slider {
        flex:1; -webkit-appearance:none; appearance:none;
        --slider-height: 24px;
        --slider-thumb-size: 26px;
        --slider-track-radius: 9999px;
        --slider-percent: 50%;
        --slider-ratio: 0.5;
        --slider-fill: var(--accent-primary);
        height: var(--slider-height);
        border-radius: var(--slider-track-radius);
        background:
          linear-gradient(to right, var(--slider-fill) 0%, var(--slider-fill) 100%),
          linear-gradient(to right, var(--surface-tertiary) 0%, var(--surface-tertiary) 100%);
        background-size:
          calc((100% - var(--slider-thumb-size)) * var(--slider-ratio) + (var(--slider-thumb-size) / 2)) 100%,
          100% 100%;
        background-repeat: no-repeat, no-repeat;
        background-position: left center, left center;
        outline:none; position:relative; cursor:pointer;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.12), var(--shadow-sm);
      }
      .slider.temperature {
        background:
          linear-gradient(to right,
            rgba(255,255,255,0.18) 0%,
            rgba(255,255,255,0.18) 100%),
          linear-gradient(to right,
            #ff9944 0%,
            #ffd480 30%,
            #ffffff 50%,
            #87ceeb 70%,
            #4d9fff 100%),
          linear-gradient(to right, var(--surface-tertiary) 0%, var(--surface-tertiary) 100%);
        background-size:
          calc((100% - var(--slider-thumb-size)) * var(--slider-ratio) + (var(--slider-thumb-size) / 2)) 100%,
          100% 100%,
          100% 100%;
        background-repeat: no-repeat, no-repeat, no-repeat;
        background-position: left center, left center, left center;
      }
      .slider::-webkit-slider-thumb {
        -webkit-appearance:none; width:var(--slider-thumb-size); height:var(--slider-thumb-size); border-radius:9999px;
        background: var(--text-primary); border:3px solid var(--surface-primary); box-shadow: 0 3px 10px rgba(0,0,0,0.35);
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
        transform: scale(1.05);
        margin-top: 0;
      }
      .slider::-webkit-slider-thumb:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
      .slider::-moz-range-thumb {
        width:var(--slider-thumb-size); height:var(--slider-thumb-size); border-radius:9999px; background: var(--text-primary);
        border:3px solid var(--surface-primary); box-shadow: 0 3px 10px rgba(0,0,0,0.35);
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
        transform: scale(1.05);
      }
      .slider::-moz-range-thumb:hover { transform: scale(1.05); box-shadow: 0 3px 10px rgba(0,0,0,0.35); }
      .slider::-moz-range-track {
        height: 100%;
        border-radius: var(--slider-track-radius);
        background: var(--slider-track);
        border: none;
      }
      .slider-value { font-size: 13px; color: var(--text-secondary); min-width: 56px; text-align:right; font-weight: 700; letter-spacing: 0.01em; align-self:center; }

      .settings-panel {
        position: absolute; top: 16px; right: 16px;
        background: rgba(20,20,20,0.98); backdrop-filter: blur(16px) saturate(160%);
        border:1px solid var(--border-medium); border-radius:12px; padding:16px; min-width: 260px;
        box-shadow: var(--shadow-md); opacity:0; pointer-events:none; transform: translateY(-6px);
        transition: opacity var(--transition-base), transform var(--transition-base); z-index:100;
      }
      .settings-panel.visible { opacity:1; pointer-events:auto; transform: translateY(0); }
      .settings-section { margin-bottom: 12px; }
      .settings-section:last-child { margin-bottom: 0; }
      .settings-label { font-size:11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; font-weight: 700; }
      .settings-option { display:flex; align-items:center; justify-content:space-between; padding: 6px 0; color: var(--text-secondary); font-size:14px; }
      .settings-size-control { display:flex; align-items:center; gap: 10px; width: 160px; }
      .settings-range {
        -webkit-appearance: none;
        appearance: none;
        flex:1;
        height: 8px;
        border-radius: 999px;
        background: var(--surface-tertiary);
        border: 1px solid var(--border-subtle);
      }
      .settings-range::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--text-primary);
        border: 2px solid var(--surface-primary);
        box-shadow: var(--shadow-sm);
        cursor: pointer;
      }
      .settings-range::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--text-primary);
        border: 2px solid var(--surface-primary);
        box-shadow: var(--shadow-sm);
        cursor: pointer;
      }
      .settings-range-value { font-size: 13px; min-width: 48px; text-align: right; color: var(--text-secondary); font-weight: 700; }

      .toggle {
        width: 44px; height:24px; background: var(--surface-tertiary); border:1px solid var(--border-subtle);
        border-radius: 9999px; position:relative; cursor:pointer; transition: all var(--transition-base);
      }
      .toggle.on { background: var(--accent-primary); border-color: var(--accent-primary); }
      .toggle::after {
        content:''; position:absolute; width:18px; height:18px; background: var(--text-primary); border-radius: 9999px; top:2px; left:2px;
        transition: left 220ms cubic-bezier(0.34,1.56,0.64,1);
      }
      .toggle.on::after { left: calc(100% - 20px); }

      .settings-button {
        width:100%; padding: 8px 10px; background: var(--surface-tertiary); border:1px solid var(--border-subtle);
        color: var(--text-secondary); border-radius: 8px; cursor:pointer; font-size:13px; font-weight:600;
        transition: background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
      }
      .settings-button:hover { background: var(--surface-elevated); border-color: var(--border-medium); color: var(--text-primary); }
      .settings-button:active { transform: scale(0.98); }

      .modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(8px);
        display:none; align-items:center; justify-content:center; z-index:1000; padding:16px;
      }
      .modal-overlay.visible { display:flex; }
      .modal {
        background: var(--surface-secondary); border:1px solid var(--border-medium); border-radius:12px; padding:20px; max-width: 700px; width:100%; max-height: 80vh; overflow:auto; box-shadow: var(--shadow-md);
      }
      .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
      .modal-title { font-size:18px; font-weight:600; color: var(--text-primary); letter-spacing: -0.01em; }
      .modal-close {
        width: 32px; height:32px; border:none; background:transparent; color: var(--text-tertiary);
        border-radius:8px; cursor:pointer; font-size:24px; display:flex; align-items:center; justify-content:center;
        transition: background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
      }
      .modal-close:hover { background: var(--surface-tertiary); color: var(--text-secondary); }
      .modal-close:active { transform: scale(0.96); }
      .yaml-output {
        background: var(--surface-primary); border:1px solid var(--border-subtle); border-radius: 8px; padding: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
        font-size: 12px; line-height: 1.6; color: var(--text-primary); white-space: pre; overflow-x: auto; user-select: all;
      }
      .modal-hint { margin-top: 8px; font-size:12px; color: var(--text-tertiary); text-align:center; }

      @media (max-width: 768px) {
        .controls-floating, .controls-below { flex-direction:column; gap: 16px; }
        .controls-floating { left: 16px; right: 16px; width: auto; transform: none; }
        .light { width: var(--light-size-mobile); height: var(--light-size-mobile); }
      }

      .settings-btn:focus-visible, .modal-close:focus-visible, .settings-button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

      :host(.overlay-active) .light,
      :host(.overlay-active) .light.selected,
      :host(.overlay-active) .light.dragging,
      :host(.overlay-active) .light-label {
        z-index: 1;
      }
    `;
  }

  _renderHeader() {
    return `
      <div class="header">
        <div class="title">${this._config.title}</div>
        ${this._config.show_settings_button ? `
          <button class="settings-btn" id="settingsBtn" aria-label="Settings" aria-expanded="${this._settingsOpen}">⚙</button>
        ` : ''}
      </div>
    `;
  }

  _resolveEntityColor(entity_id, isOn, attributes) {
    const [domain] = entity_id.split('.');
    const override = this._config.color_overrides?.[entity_id];

    // Helper to extract override based on state
    const getOverride = (state) => {
      if (!override) return null;
      if (typeof override === 'string') return state === 'on' ? override : null;
      if (state === 'on') return override.state_on || override.on || null;
      return override.state_off || override.off || null;
    };

    if (domain === 'scene') {
      const ov = getOverride('on') || (typeof override === 'string' ? override : null);
      return ov || this._config.scene_color;
    }

    if (isOn) {
      const ov = getOverride('on');
      if (ov) return ov;

      if (domain === 'switch' || domain === 'input_boolean') return this._config.switch_on_color;
      
      if (attributes && attributes.rgb_color) {
        const [r, g, b] = attributes.rgb_color;
        return `rgb(${r}, ${g}, ${b})`;
      }
      return '#ffa500';
    } else {
      const ov = getOverride('off');
      if (ov) return ov;

      if (domain === 'switch' || domain === 'input_boolean') return this._config.switch_off_color;
      return 'transparent';
    }
  }

  _renderLightsHTML() {
    return this._config.entities.map(entity_id => {
      const pos = this._config.positions[entity_id] || { x: 50, y: 50 };
      const st = this._hass?.states[entity_id];
      if (!st) return '';

      const [domain] = entity_id.split('.');
      const isOn = st.state === 'on';
      const isSelected = this._selectedLights.has(entity_id);
      const label = this._generateLabel(entity_id);

      const color = this._resolveEntityColor(entity_id, isOn, st.attributes);
      const displayColor = (color && color !== 'transparent') ? color : this._config.switch_off_color;

      const iconData = (this._config.show_entity_icons || this._config.icon_only) ? this._getEntityIconData(entity_id) : null;
      const stateClass = (domain === 'scene' || isOn) ? 'on' : 'off';
      const classes = ['light', stateClass];
      if (isSelected) classes.push('selected');
      if (this._config.icon_only) classes.push('icon-only');
      
      let style = `left:${pos.x}%; top:${pos.y}%;`;
      style += `--light-color:${displayColor}; --light-icon-color:${this._config.icon_only ? displayColor : 'rgba(255,255,255,0.92)'};`;
      if (!this._config.icon_only && color !== 'transparent') {
        style += `background:${color};`;
      } else if (!this._config.icon_only) {
        style += `background:`; // Allow CSS gradient fallback
      }

      return `
        <div class="${classes.join(' ')}"
             style="${style}"
             data-entity="${entity_id}"
             tabindex="0"
             role="button"
             aria-label="${st.attributes.friendly_name || entity_id}"
             aria-pressed="${isSelected}">
          ${iconData ? this._renderIcon(iconData) : ''}
          <div class="light-label">${label}</div>
        </div>
      `;
    }).join('');
  }

  _renderControlsFloating(visible, controlContext) {
    const { avgState, tempRange } = controlContext;
    const clampedTemp = this._clampTemperature(avgState.temperature, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (avgState.brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((clampedTemp - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';
    return `
      <div class="controls-floating ${visible ? 'visible' : ''}" id="controlsFloating" role="region" aria-label="Light controls" aria-live="polite">
        <canvas id="colorWheelMini" class="color-wheel-mini" width="256" height="256" role="img" aria-label="Color picker"></canvas>
        <div class="slider-group">
          <div class="slider-row">
            <input type="range" class="slider" id="brightnessSlider" min="0" max="255" value="${avgState.brightness}" aria-label="Brightness" style="--slider-percent:${brightnessPercent}%;--slider-ratio:${brightnessPercent/100};--slider-fill:${brightnessColor};">
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness/255)*100)}%</span>
          </div>
          <div class="slider-row">
            <input type="range" class="slider temperature" id="temperatureSlider" min="${tempRange.min}" max="${tempRange.max}" value="${clampedTemp}" aria-label="Color temperature" style="--slider-percent:${tempPercent}%;--slider-ratio:${tempPercent/100};">
            <span class="slider-value" id="temperatureValue">${clampedTemp}K</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderControlsBelow(controlContext) {
    const { avgState, tempRange } = controlContext;
    const clampedTemp = this._clampTemperature(avgState.temperature, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (avgState.brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((clampedTemp - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';
    return `
      <div class="controls-below" id="controlsBelow" role="region" aria-label="Light controls" aria-live="polite">
        <canvas id="colorWheelMini" class="color-wheel-mini" width="256" height="256" role="img" aria-label="Color picker"></canvas>
        <div class="slider-group">
          <div class="slider-row">
            <input type="range" class="slider" id="brightnessSlider" min="0" max="255" value="${avgState.brightness}" aria-label="Brightness" style="--slider-percent:${brightnessPercent}%;--slider-ratio:${brightnessPercent/100};--slider-fill:${brightnessColor};">
            <span class="slider-value" id="brightnessValue">${Math.round((avgState.brightness/255)*100)}%</span>
          </div>
          <div class="slider-row">
            <input type="range" class="slider temperature" id="temperatureSlider" min="${tempRange.min}" max="${tempRange.max}" value="${clampedTemp}" aria-label="Color temperature" style="--slider-percent:${tempPercent}%;--slider-ratio:${tempPercent/100};">
            <span class="slider-value" id="temperatureValue">${clampedTemp}K</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderSettings() {
    return `
      <div class="settings-panel ${this._settingsOpen ? 'visible' : ''}" id="settingsPanel" role="dialog" aria-label="Settings">
        <div class="settings-section">
          <div class="settings-label">Positioning</div>
          <div class="settings-option">
            <span>Lock Positions</span>
            <button class="toggle ${this._lockPositions ? 'on' : ''}" id="lockToggle" role="switch" aria-checked="${this._lockPositions}" aria-label="Lock positions"></button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Display</div>
          <div class="settings-option">
            <span>Show Entity Icons</span>
            <button class="toggle ${this._config.show_entity_icons ? 'on' : ''}" id="iconToggle" role="switch" aria-checked="${this._config.show_entity_icons}" aria-label="Show entity icons"></button>
          </div>
          <div class="settings-option">
            <span>Icon Only Mode</span>
            <button class="toggle ${this._config.icon_only ? 'on' : ''}" id="iconOnlyToggle" role="switch" aria-checked="${this._config.icon_only}" aria-label="Display icons without circles"></button>
          </div>
          <div class="settings-option settings-size">
            <span>Light Size</span>
            <div class="settings-size-control">
              <input type="range" class="settings-range" id="lightSizeSlider" min="32" max="96" value="${this._config.light_size}" aria-label="Light size">
              <span class="settings-range-value" id="lightSizeValue">${this._config.light_size}px</span>
            </div>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Interaction</div>
          <div class="settings-option">
            <span>Single-Tap Switch/Scene</span>
            <button class="toggle ${this._config.switch_single_tap ? 'on' : ''}" id="switchTapToggle" role="switch" aria-checked="${this._config.switch_single_tap}" aria-label="Toggle switches with a single tap"></button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">Layout</div>
          <button class="settings-button" id="rearrangeBtn">Rearrange All Lights</button>
        </div>
        <div class="settings-section">
          <div class="settings-label">Grid</div>
          <div class="settings-option"><span>Size: ${this._gridSize}px</span></div>
        </div>
        <div class="settings-section">
          <button class="settings-button" id="exportBtn">Export Configuration</button>
        </div>
      </div>
    `;
  }

  _renderYamlModal() {
    return `
      <div class="modal-overlay ${this._yamlModalOpen ? 'visible' : ''}" id="yamlModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title" id="modalTitle">Configuration YAML</span>
            <button class="modal-close" id="closeModal" aria-label="Close">×</button>
          </div>
          <div class="yaml-output" id="yamlOutput" role="textbox" aria-multiline="true" aria-readonly="true">${this._generateYAML()}</div>
          <div class="modal-hint">Select all (Cmd/Ctrl+A) and copy (Cmd/Ctrl+C)</div>
        </div>
      </div>
    `;
  }

  _updateControlValues(controlContext) {
    const context = controlContext || { avgState: { brightness: 128, temperature: 4000 }, tempRange: { min: 2000, max: 6500 } };
    const { avgState, tempRange } = context;
    const brightness = Number.isFinite(avgState?.brightness) ? avgState.brightness : 128;
    const temperature = Number.isFinite(avgState?.temperature)
      ? this._clampTemperature(avgState.temperature, tempRange)
      : this._clampTemperature(4000, tempRange);
    const brightnessPercent = Math.min(100, Math.max(0, (brightness / 255) * 100));
    const tempPercent = (tempRange.max > tempRange.min)
      ? Math.min(100, Math.max(0, ((temperature - tempRange.min) / (tempRange.max - tempRange.min)) * 100))
      : 0;
    const brightnessColor = Array.isArray(avgState?.color) ? `rgb(${avgState.color.join(',')})` : 'var(--accent-primary)';

    if (this._els.brightnessSlider) {
      this._els.brightnessSlider.value = String(brightness);
      this._els.brightnessSlider.style.setProperty('--slider-percent', `${brightnessPercent}%`);
      this._els.brightnessSlider.style.setProperty('--slider-ratio', `${brightnessPercent / 100}`);
      this._els.brightnessSlider.style.setProperty('--slider-fill', brightnessColor);
    }
    if (this._els.brightnessValue) {
      this._els.brightnessValue.textContent = `${Math.round((brightness / 255) * 100)}%`;
    }
    if (this._els.temperatureSlider) {
      if (this._els.temperatureSlider.min !== String(tempRange.min)) {
        this._els.temperatureSlider.min = String(tempRange.min);
      }
      if (this._els.temperatureSlider.max !== String(tempRange.max)) {
        this._els.temperatureSlider.max = String(tempRange.max);
      }
      this._els.temperatureSlider.value = String(temperature);
      this._els.temperatureSlider.style.setProperty('--slider-percent', `${tempPercent}%`);
      this._els.temperatureSlider.style.setProperty('--slider-ratio', `${tempPercent / 100}`);
    }
    if (this._els.temperatureValue) {
      this._els.temperatureValue.textContent = `${temperature}K`;
    }
  }

  _updateSliderVisual(el) {
    if (!el) return;
    const min = parseFloat(el.min || '0');
    const max = parseFloat(el.max || '100');
    const val = parseFloat(el.value || '0');
    const percent = Number.isFinite(min) && Number.isFinite(max) && max > min
      ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100))
      : 0;
    el.style.setProperty('--slider-percent', `${percent}%`);
    el.style.setProperty('--slider-ratio', `${percent / 100}`);
  }

  _bindSliderGesture(el) {
    if (!el) return;

    const updateVisuals = () => {
      this._updateSliderVisual(el);
      // Manually update labels since programmatic changes don't fire input events
      if (el.id === 'brightnessSlider' && this._els.brightnessValue) {
        const pct = Math.round((parseInt(el.value, 10) / 255) * 100);
        this._els.brightnessValue.textContent = `${pct}%`;
      } else if (el.id === 'temperatureSlider' && this._els.temperatureValue) {
        this._els.temperatureValue.textContent = `${el.value}K`;
      }
    };

    const state = {
      pointerId: null,
      startX: 0,
      startY: 0,
      startValue: null,
      isScrolling: false,
      locked: false
    };

    el.addEventListener('pointerdown', (e) => {
      // Prevent default browser dragging to ensure we handle the gesture
      e.preventDefault();
      el.setPointerCapture(e.pointerId);

      state.pointerId = e.pointerId;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.startValue = el.value;
      state.isScrolling = false;
      state.locked = false;

      // Immediate update on tap start
      this._applyPointerValue(el, e.clientX);
      updateVisuals();
    });

    el.addEventListener('pointermove', (e) => {
      if (state.pointerId !== e.pointerId) return;
      if (state.isScrolling) return;

      const dx = Math.abs(e.clientX - state.startX);
      const dy = Math.abs(e.clientY - state.startY);

      // Check for scroll intent if not yet locked
      if (!state.locked && (dx > 6 || dy > 6)) {
        state.locked = true;
        if (dy > dx) {
          // Vertical scroll detected - Revert interaction
          state.isScrolling = true;
          el.value = state.startValue;
          updateVisuals();
          el.releasePointerCapture(e.pointerId);
          return;
        }
      }

      // If we aren't scrolling, follow the finger
      this._applyPointerValue(el, e.clientX);
      updateVisuals();
    });

    const endInteraction = (e) => {
      if (state.pointerId !== e.pointerId) return;
      el.releasePointerCapture(e.pointerId);
      state.pointerId = null;

      if (!state.isScrolling) {
        // Commit change
        if (el.id === 'brightnessSlider') {
          this._pendingBrightness = parseInt(el.value, 10);
          this._handleBrightnessChange();
        } else if (el.id === 'temperatureSlider') {
          this._pendingTemperature = parseInt(el.value, 10);
          this._handleTemperatureChange();
        }
      }
    };

    el.addEventListener('pointerup', endInteraction);
    el.addEventListener('pointercancel', endInteraction);
  }

  _applyPointerValue(el, clientX) {
    const rect = el.getBoundingClientRect();
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    
    // The thumb size matches CSS --slider-thumb-size: 26px
    const thumbSize = 26;
    
    // Calculate the effective travel distance of the thumb's center
    const availableWidth = rect.width - thumbSize;
    
    // Offset relative to the start of the travel area
    const offset = clientX - rect.left - (thumbSize / 2);
    
    let pct = 0;
    if (availableWidth > 0) {
      pct = offset / availableWidth;
    }
    
    pct = Math.max(0, Math.min(1, pct));
    el.value = Math.round(min + pct * (max - min));
  }

  _applyLightSize(size) {
    const normalized = this._normalizeLightSize(size);
    this._lightSize = normalized;
    this.style.setProperty('--light-size', `${normalized}px`);
  }

  /** ---------- Events ---------- */
  connectedCallback() {
    if (!this._boundKeyDown) {
      this._boundKeyDown = (e) => this._handleKeyDown(e);
      document.addEventListener('keydown', this._boundKeyDown);
    }
    if (typeof window !== 'undefined') {
      this._boundIconsetAdded = () => this._refreshEntityIcons();
      window.addEventListener('iron-iconset-added', this._boundIconsetAdded);
      this._boundMoreInfo = (event) => {
        if (event.detail && 'entityId' in event.detail) {
          this._moreInfoOpen = Boolean(event.detail.entityId);
          this._syncOverlayState();
        }
      };
      window.addEventListener('hass-more-info', this._boundMoreInfo, { passive: true });
    }
  }
  disconnectedCallback() {
    if (this._boundKeyDown) {
      document.removeEventListener('keydown', this._boundKeyDown);
      this._boundKeyDown = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._boundCloseSettings) {
      document.removeEventListener('click', this._boundCloseSettings);
      this._boundCloseSettings = null;
    }
    if (this._boundIconsetAdded && typeof window !== 'undefined') {
      window.removeEventListener('iron-iconset-added', this._boundIconsetAdded);
      this._boundIconsetAdded = null;
    }
    if (this._boundMoreInfo && typeof window !== 'undefined') {
      window.removeEventListener('hass-more-info', this._boundMoreInfo);
      this._boundMoreInfo = null;
    }
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    if (this._iconRefreshHandle) {
      clearTimeout(this._iconRefreshHandle);
      this._iconRefreshHandle = null;
    }
    if (this._iconRehydrateHandle) {
      clearTimeout(this._iconRehydrateHandle);
      this._iconRehydrateHandle = null;
    }
    if (this._colorWheelObserver) {
      this._colorWheelObserver.disconnect();
      this._colorWheelObserver = null;
    }
    if (this._colorWheelFrame) {
      const cancel = this._colorWheelCancel || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout);
      cancel(this._colorWheelFrame);
      this._colorWheelFrame = null;
    }
    this._pendingTap = null;
    this._longPressTriggered = false;
    this._moreInfoOpen = false;
    this.classList.remove('overlay-active');
  }

  _attachEventListeners() {
    // Pointer events on canvas (unified)
    if (this._els.canvas) {
      this._els.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      this._els.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
      this._els.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
      this._els.canvas.addEventListener('pointercancel', (e) => this._onPointerCancel(e));
      this._els.canvas.addEventListener('dblclick', (e) => this._handleCanvasDoubleClick(e));
      this._els.canvas.addEventListener('contextmenu', (e) => this._handleCanvasContextMenu(e));
    }

    // Settings button (no full re-render)
    if (this._els.settingsBtn) {
      this._els.settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._settingsOpen = !this._settingsOpen;
        if (this._els.settingsPanel) this._els.settingsPanel.classList.toggle('visible', this._settingsOpen);
        this._els.settingsBtn.setAttribute('aria-expanded', String(this._settingsOpen));
        this._syncOverlayState();
      });
    }

    // Close settings when clicking outside (delegate to document)
    if (this._boundCloseSettings) {
      document.removeEventListener('click', this._boundCloseSettings);
      this._boundCloseSettings = null;
    }
    this._boundCloseSettings = (e) => {
      if (this._settingsOpen &&
        !e.target.closest('.settings-panel') &&
        !e.target.closest('.settings-btn')) {
        this._settingsOpen = false;
        if (this._els.settingsPanel) this._els.settingsPanel.classList.remove('visible');
        if (this._els.settingsBtn) this._els.settingsBtn.setAttribute('aria-expanded', 'false');
        this._syncOverlayState();
      }
    };
    document.addEventListener('click', this._boundCloseSettings);

    if (this._els.lockToggle) {
      this._els.lockToggle.addEventListener('click', () => {
        this._lockPositions = !this._lockPositions;
        this._els.lockToggle.classList.toggle('on', this._lockPositions);
        this._els.lockToggle.setAttribute('aria-checked', String(this._lockPositions));
        // Update cursor affordance without re-render:
        this.shadowRoot.querySelectorAll('.light').forEach(l => {
          l.style.cursor = this._lockPositions ? 'pointer' : 'grab';
        });
      });
    }

    if (this._els.iconToggle) {
      this._els.iconToggle.addEventListener('click', () => {
        this._config.show_entity_icons = !this._config.show_entity_icons;
        this._els.iconToggle.classList.toggle('on', this._config.show_entity_icons);
        this._els.iconToggle.setAttribute('aria-checked', String(this._config.show_entity_icons));
        // Update light contents
        this._rerenderLightIconsOnly();
      });
    }

    if (this._els.iconOnlyToggle) {
      this._els.iconOnlyToggle.addEventListener('click', () => {
        this._config.icon_only = !this._config.icon_only;
        this._els.iconOnlyToggle.classList.toggle('on', this._config.icon_only);
        this._els.iconOnlyToggle.setAttribute('aria-checked', String(this._config.icon_only));
        this._applyIconOnlyMode();
      });
    }

    if (this._els.lightSizeSlider) {
      const updateLabel = (val) => {
        if (this._els.lightSizeValue) this._els.lightSizeValue.textContent = `${val}px`;
      };
      this._els.lightSizeSlider.addEventListener('input', (e) => {
        const val = this._normalizeLightSize(parseInt(e.target.value, 10));
        this._config.light_size = val;
        this._applyLightSize(val);
        updateLabel(val);
      });
    }

    if (this._els.switchTapToggle) {
      this._els.switchTapToggle.addEventListener('click', () => {
        this._config.switch_single_tap = !this._config.switch_single_tap;
        this._els.switchTapToggle.classList.toggle('on', this._config.switch_single_tap);
        this._els.switchTapToggle.setAttribute('aria-checked', String(this._config.switch_single_tap));
      });
    }

    if (this._els.rearrangeBtn) {
      this._els.rearrangeBtn.addEventListener('click', () => {
        this._rearrangeAllLights();
      });
    }

    if (this._els.exportBtn) {
      this._els.exportBtn.addEventListener('click', () => {
        this._yamlModalOpen = true;
        if (this._els.yamlModal) this._els.yamlModal.classList.add('visible');
        if (this._els.yamlOutput) this._els.yamlOutput.textContent = this._generateYAML();
        this._syncOverlayState();
      });
    }

    // Modal close
    const closeModal = this.shadowRoot.getElementById('closeModal');
    if (closeModal) {
      closeModal.addEventListener('click', () => {
        this._yamlModalOpen = false;
        if (this._els.yamlModal) this._els.yamlModal.classList.remove('visible');
        this._syncOverlayState();
      });
    }
    if (this._els.yamlModal) {
      this._els.yamlModal.addEventListener('click', (e) => {
        if (e.target === this._els.yamlModal) {
          this._yamlModalOpen = false;
          this._els.yamlModal.classList.remove('visible');
          this._syncOverlayState();
        }
      });
    }

    // Controls events
    if (this._els.colorWheel) {
      this._els.colorWheel.addEventListener('pointerdown', (e) => {
        const isTouchLike = e.pointerType === 'touch' || e.pointerType === 'pen' || !e.pointerType;
        this._colorWheelActive = true;
        this._colorWheelGesture = {
          pointerId: e.pointerId,
          isTouch: isTouchLike,
          startScroll: this._getScrollPosition(),
          scrolled: false,
          pendingColor: null,
        };
        e.preventDefault();
        e.target.setPointerCapture?.(e.pointerId);

        const color = this._getColorWheelColorAtEvent(e);
        if (!color) return;
        if (isTouchLike) {
          this._colorWheelGesture.pendingColor = color;
        } else {
          this._applyColorWheelSelection(color);
        }
      });
      this._els.colorWheel.addEventListener('pointermove', (e) => {
        if (this._colorWheelActive) {
          const gesture = this._colorWheelGesture;
          if (!gesture || (gesture.pointerId !== undefined && gesture.pointerId !== e.pointerId)) return;

          const scrollPos = this._getScrollPosition();
          if (scrollPos.x !== gesture.startScroll.x || scrollPos.y !== gesture.startScroll.y) {
            gesture.scrolled = true;
            return;
          }

          const color = this._getColorWheelColorAtEvent(e);
          if (!color) return;

          if (gesture.isTouch) {
            gesture.pendingColor = color;
          } else {
            e.preventDefault();
            this._applyColorWheelSelection(color);
          }
        }
      });
      this._els.colorWheel.addEventListener('pointerup', (e) => {
        this._colorWheelActive = false;
        e.target.releasePointerCapture?.(e.pointerId);

        const gesture = this._colorWheelGesture;
        this._colorWheelGesture = null;
        if (!gesture || gesture.pointerId !== e.pointerId) return;

        if (gesture.isTouch && !gesture.scrolled) {
          const color = this._getColorWheelColorAtEvent(e) || gesture.pendingColor;
          if (color) this._applyColorWheelSelection(color);
        }
      });
      this._els.colorWheel.addEventListener('pointercancel', (e) => {
        this._colorWheelActive = false;
        e.target.releasePointerCapture?.(e.pointerId);
        this._colorWheelGesture = null;
      });
    }
    if (this._els.brightnessSlider) {
      // Input/Change listeners kept for keyboard support but logic dominated by pointer events
      this._els.brightnessSlider.addEventListener('input', (e) => this._handleBrightnessInput(e));
      this._els.brightnessSlider.addEventListener('change', () => this._handleBrightnessChange());
      this._bindSliderGesture(this._els.brightnessSlider);
    }
    if (this._els.temperatureSlider) {
      this._els.temperatureSlider.addEventListener('input', (e) => this._handleTemperatureInput(e));
      this._els.temperatureSlider.addEventListener('change', () => this._handleTemperatureChange());
      this._bindSliderGesture(this._els.temperatureSlider);
    }
  }

  _rerenderLightIconsOnly() {
    const nodes = this.shadowRoot.querySelectorAll('.light');
    nodes.forEach(light => {
      const entity = light.dataset.entity;
      const iconWrap = light.querySelector('.light-icon, ha-icon, ha-svg-icon, .light-icon-emoji');
      if (iconWrap) iconWrap.remove();
      if (this._config.show_entity_icons || this._config.icon_only) {
        const iconData = this._getEntityIconData(entity);
        light.insertAdjacentHTML('afterbegin', this._renderIcon(iconData));
      }
    });
    this._refreshEntityIcons();
  }

  _applyIconOnlyMode() {
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const color = light.style.getPropertyValue('--light-color') || this._config.switch_off_color;
      const iconColor = this._config.icon_only ? (color || this._config.switch_off_color) : 'rgba(255,255,255,0.92)';
      light.classList.toggle('icon-only', this._config.icon_only);
      light.style.setProperty('--light-icon-color', iconColor);
      if (this._config.icon_only) {
        light.style.background = 'transparent';
      }
    });
    this._rerenderLightIconsOnly();
    this.updateLights();
  }

  _commitSelection(newSelection) {
    const updatedSelection = new Set(newSelection);
    this._selectedLights.clear();
    updatedSelection.forEach(entity => this._selectedLights.add(entity));
    this.updateLights();
    const shouldDrawWheel =
      (this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) &&
      Boolean(this._els.colorWheel);
    if (shouldDrawWheel) {
      this._requestColorWheelDraw();
    }
  }

  /** ---------- Keyboard ---------- */
  _handleKeyDown(e) {
    // Undo/Redo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey))) { e.preventDefault(); this._redo(); }
    // Escape → deselect and close panels
    if (e.key === 'Escape') {
      this._selectedLights.clear();
      if (this._settingsOpen) this._settingsOpen = false;
      if (this._yamlModalOpen) this._yamlModalOpen = false;
      if (this._els.settingsPanel) this._els.settingsPanel.classList.remove('visible');
      if (this._els.yamlModal) this._els.yamlModal.classList.remove('visible');
      if (this._moreInfoOpen) {
        this.dispatchEvent(new CustomEvent('hass-more-info', {
          detail: { entityId: null },
          bubbles: true,
          composed: true,
        }));
      }
      this._moreInfoOpen = false;
      this._syncOverlayState();
      this.updateLights();
    }
    // Select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      this._selectedLights.clear();
      this._config.entities.forEach(ent => this._selectedLights.add(ent));
      this.updateLights();
      if (this._els.colorWheel) this._requestColorWheelDraw();
    }
    // Optional: movement with arrows if unlocked
    if (!this._lockPositions && this._selectedLights.size > 0) {
      const step = e.altKey ? 1 : 0.5; // fine control with Alt
      let moved = false;
      const delta = { x: 0, y: 0 };
      if (e.key === 'ArrowLeft') { delta.x = -step; moved = true; }
      if (e.key === 'ArrowRight') { delta.x = step; moved = true; }
      if (e.key === 'ArrowUp') { delta.y = -step; moved = true; }
      if (e.key === 'ArrowDown') { delta.y = step; moved = true; }
      if (moved) {
        e.preventDefault();
        this._selectedLights.forEach(entity => {
          const pos = this._config.positions[entity] || { x: 50, y: 50 };
          const nx = Math.max(0, Math.min(100, pos.x + delta.x));
          const ny = Math.max(0, Math.min(100, pos.y + delta.y));
          this._config.positions[entity] = { x: nx, y: ny };
        });
        this._smoothApplyPositions();
        this._saveHistory();
      }
    }
  }

  /** ---------- Pointer (unified mouse/touch/pen) ---------- */
  _onPointerDown(e) {
    if (!this._els.canvas) return;
    e.target.setPointerCapture?.(e.pointerId);

    const targetLight = e.target.closest('.light');
    if (targetLight) {
      const entity = targetLight.dataset.entity;
      const pointerType = e.pointerType || 'mouse';
      const [domain] = entity.split('.');
      // Check if this entity type is configured to toggle on single tap
      const toggleOnSingleTap = this._config.switch_single_tap && (domain === 'switch' || domain === 'input_boolean' || domain === 'scene');
      
      if (this._lockPositions) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (this._longPressTimer) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
        this._longPressTriggered = false;
        const longPressDelay = pointerType === 'mouse' ? 650 : 500;
        this._longPressTimer = setTimeout(() => {
          this._longPressTimer = null;
          this._longPressTriggered = true;
          this._pendingTap = null;
          this._lastTap = null;
          if (pointerType !== 'mouse' && typeof navigator !== 'undefined' && navigator.vibrate) {
            navigator.vibrate(30);
          }
          this._openMoreInfo(entity);
        }, longPressDelay);
        if (pointerType === 'touch' || pointerType === 'pen') {
          this._pendingTap = {
            entity,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            additive,
            pointerType,
            toggleOnSingleTap,
          };
        } else {
          if (toggleOnSingleTap) {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const isRepeat = this._lastTap && this._lastTap.entity === entity && (now - this._lastTap.time) < 350;
            if (!isRepeat) {
              this._toggleEntity(entity);
            }
            this._lastTap = { entity, time: now };
            return;
          }
          const newSelection = new Set(this._selectedLights);
          if (additive) {
            if (newSelection.has(entity)) newSelection.delete(entity);
            else newSelection.add(entity);
          } else {
            newSelection.clear();
            newSelection.add(entity);
          }
          this._commitSelection(newSelection);
        }
        return;
      }

      if (!this._selectedLights.has(entity)) {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        const newSelection = new Set(this._selectedLights);
        if (!additive) newSelection.clear();
        newSelection.add(entity);
        this._commitSelection(newSelection);
      }

      this._pendingTap = null;
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
      this._longPressTriggered = false;

      // Begin drag
      const rect = this._els.canvas.getBoundingClientRect();
      this._dragState = {
        entity,
        startX: e.clientX,
        startY: e.clientY,
        initialLeft: parseFloat(targetLight.style.left),
        initialTop: parseFloat(targetLight.style.top),
        rect,
        moved: false,
      };
      targetLight.classList.add('dragging');
      // Pre-history snapshot if necessary
      this._saveHistory();
      return;
    }

    // Start canvas selection rubberband
    if (e.target.id === 'canvas' || e.target.classList.contains('grid')) {
      const rect = this._els.canvas.getBoundingClientRect();
      this._selectionStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._selectionBox = document.createElement('div');
      this._selectionBox.className = 'selection-box';
      this._els.canvas.appendChild(this._selectionBox);
      this._selectionModeAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
      this._selectionBase = this._selectionModeAdditive ? new Set(this._selectedLights) : null;
      if (!this._selectionModeAdditive) {
        this._selectedLights.clear();
        this.updateLights();
      }
    }
  }

  _onPointerMove(e) {
    if (this._pendingTap && e.pointerId === this._pendingTap.pointerId) {
      const dx = e.clientX - this._pendingTap.startX;
      const dy = e.clientY - this._pendingTap.startY;
      if (Math.hypot(dx, dy) > 12) {
        if (this._longPressTimer) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
        this._pendingTap = null;
        this._lastTap = null;
      }
    }

    if (this._dragState) {
      e.preventDefault();
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        const { rect, startX, startY, initialLeft, initialTop, entity } = this._dragState;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._dragState.moved = true;

        let xPercent = initialLeft + (dx / rect.width) * 100;
        let yPercent = initialTop + (dy / rect.height) * 100;
        const snapped = this._snapToGrid(xPercent, yPercent, e);
        xPercent = Math.max(0, Math.min(100, snapped.x));
        yPercent = Math.max(0, Math.min(100, snapped.y));

        const node = this.shadowRoot.querySelector(`.light[data-entity="${entity}"]`);
        if (node) {
          node.style.left = `${xPercent}%`;
          node.style.top = `${yPercent}%`;
        }
      });
      return;
    }

    if (this._selectionBox && this._selectionStart) {
      e.preventDefault();
      const rect = this._els.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const left = Math.min(this._selectionStart.x, x);
      const top = Math.min(this._selectionStart.y, y);
      const width = Math.abs(x - this._selectionStart.x);
      const height = Math.abs(y - this._selectionStart.y);
      Object.assign(this._selectionBox.style, {
        left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
      });
      this._selectLightsInBox(left, top, width, height);
    }
  }

  _onPointerUp(e) {
    e.target.releasePointerCapture?.(e.pointerId);
    if (this._dragState) {
      const { entity, moved } = this._dragState;
      const node = this.shadowRoot.querySelector(`.light[data-entity="${entity}"]`);
      if (node) {
        node.classList.remove('dragging');
        const finalLeft = parseFloat(node.style.left);
        const finalTop = parseFloat(node.style.top);
        this._config.positions[entity] = { x: finalLeft, y: finalTop };
      }
      if (moved) {
        this._saveHistory();
      }
      this._dragState = null;
    }

    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
      this._selectionStart = null;
      this._selectionBase = null;
      this._selectionModeAdditive = false;
    }

    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    if (this._pendingTap && e.pointerId === this._pendingTap.pointerId) {
      if (!this._longPressTriggered) {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const isTouch = this._pendingTap.pointerType === 'touch' || this._pendingTap.pointerType === 'pen';
        if (this._pendingTap.toggleOnSingleTap) {
          const isRepeat = this._lastTap && this._lastTap.entity === this._pendingTap.entity && (now - this._lastTap.time) < 350;
          if (!isRepeat) {
            this._toggleEntity(this._pendingTap.entity);
          }
          this._lastTap = { entity: this._pendingTap.entity, time: now };
        } else if (isTouch && this._lastTap && this._lastTap.entity === this._pendingTap.entity && (now - this._lastTap.time) < 350) {
          this._toggleEntity(this._pendingTap.entity);
          this._lastTap = null;
        } else {
          if (isTouch) {
            this._lastTap = { entity: this._pendingTap.entity, time: now };
          } else {
            this._lastTap = null;
          }
          const newSelection = this._pendingTap.additive
            ? new Set(this._selectedLights)
            : new Set();
          if (this._pendingTap.additive && newSelection.has(this._pendingTap.entity)) {
            newSelection.delete(this._pendingTap.entity);
          } else {
            newSelection.add(this._pendingTap.entity);
          }
          this._commitSelection(newSelection);
        }
      }
      this._pendingTap = null;
    }

    this._longPressTriggered = false;
  }

  _onPointerCancel() {
    this._cancelActiveInteractions();
  }

  _handleCanvasDoubleClick(e) {
    const targetLight = e.target.closest('.light');
    if (!targetLight) return;
    const entity = targetLight.dataset.entity;
    if (!entity) return;
    const [domain] = entity.split('.');
    if (this._config.switch_single_tap && (domain === 'switch' || domain === 'input_boolean' || domain === 'scene')) {
      return;
    }
    e.preventDefault();
    this._toggleEntity(entity);
    this._lastTap = null;
  }

  _handleCanvasContextMenu(e) {
    const targetLight = e.target.closest('.light');
    if (!targetLight) return;
    const entity = targetLight.dataset.entity;
    if (!entity) return;
    e.preventDefault();
    this._openMoreInfo(entity);
    this._lastTap = null;
  }

  _cancelActiveInteractions() {
    this._dragState = null;
    if (this.shadowRoot) {
      this.shadowRoot.querySelectorAll('.light.dragging').forEach(node => node.classList.remove('dragging'));
    }
    if (this._selectionBox) {
      this._selectionBox.remove();
      this._selectionBox = null;
    }
    this._selectionBase = null;
    this._selectionModeAdditive = false;
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._pendingTap = null;
    this._longPressTriggered = false;
  }

  _selectLightsInBox(left, top, width, height) {
    const lights = this.shadowRoot.querySelectorAll('.light');
    const rect = this._els.canvas.getBoundingClientRect();
    const inside = new Set();
    lights.forEach(light => {
      const r = light.getBoundingClientRect();
      const cx = r.left - rect.left + r.width / 2;
      const cy = r.top - rect.top + r.height / 2;
      if (cx >= left && cx <= left + width && cy >= top && cy <= top + height) {
        inside.add(light.dataset.entity);
      }
    });
    if (this._selectionModeAdditive && this._selectionBase) {
      this._commitSelection(new Set([...this._selectionBase, ...inside]));
    } else {
      this._commitSelection(inside);
    }
  }

  _syncOverlayState() {
    const overlayActive = this._settingsOpen || this._yamlModalOpen || this._moreInfoOpen;
    this.classList.toggle('overlay-active', overlayActive);
  }

  /** ---------- Color control ---------- */
  _getScrollPosition() {
    if (typeof window === 'undefined') return { x: 0, y: 0 };
    const x = typeof window.scrollX === 'number' ? window.scrollX : window.pageXOffset || 0;
    const y = typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset || 0;
    return { x, y };
  }

  _getColorWheelColorAtEvent(e) {
    const canvas = this._els.colorWheel;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const imageData = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1);
    const [r, g, b, a] = imageData.data;
    if (a === 0) return null; // click outside painted area (shouldn't happen with full wheel)

    return [r, g, b];
  }

  _applyColorWheelSelection(rgb) {
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0 || !rgb) return;

    this._pendingColor = rgb;
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', {
        entity_id,
        rgb_color: this._pendingColor,
      });
    });
    this._pendingColor = null;
  }

  _handleBrightnessInput(e) {
    const val = parseInt(e.target.value, 10);
    if (e.target.dataset.ignoreChange === 'true') {
      e.target.value = e.target.dataset.startValue || e.target.value;
      this._updateSliderVisual(e.target);
      return;
    }
    if (this._els.brightnessValue) this._els.brightnessValue.textContent = `${Math.round((val / 255) * 100)}%`;
    this._updateSliderVisual(this._els.brightnessSlider);
    this._pendingBrightness = val;
  }
  _handleBrightnessChange() {
    if (this._pendingBrightness == null) return;
    if (this._els.brightnessSlider && this._els.brightnessSlider.dataset.ignoreChange === 'true') {
      this._pendingBrightness = null;
      return;
    }
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0) { this._pendingBrightness = null; return; }

    const b = this._pendingBrightness;
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', { entity_id, brightness: b });
    });
    this._pendingBrightness = null;
  }

  _handleTemperatureInput(e) {
    const k = parseInt(e.target.value, 10);
    if (e.target.dataset.ignoreChange === 'true') {
      e.target.value = e.target.dataset.startValue || e.target.value;
      this._updateSliderVisual(e.target);
      return;
    }
    if (this._els.temperatureValue) this._els.temperatureValue.textContent = `${k}K`;
    this._updateSliderVisual(this._els.temperatureSlider);
    this._pendingTemperature = k;
  }
  _handleTemperatureChange() {
    if (this._pendingTemperature == null) return;
    if (this._els.temperatureSlider && this._els.temperatureSlider.dataset.ignoreChange === 'true') {
      this._pendingTemperature = null;
      return;
    }
    const controlled = this._selectedLights.size > 0
      ? [...this._selectedLights]
      : (this._config.default_entity ? [this._config.default_entity] : []);
    if (controlled.length === 0) { this._pendingTemperature = null; return; }

    const mireds = Math.round(1000000 / this._pendingTemperature);
    controlled.forEach(entity_id => {
      this._hass.callService('light', 'turn_on', { entity_id, color_temp: mireds });
    });
    this._pendingTemperature = null;
  }

  _requestColorWheelDraw(force = false) {
    if (this._colorWheelFrame) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    this._colorWheelCancel = cancel;
    this._colorWheelFrame = schedule(() => {
      this._colorWheelFrame = null;
      this.drawColorWheel(force);
    });
  }

  drawColorWheel(force = false) {
    const canvas = this._els.colorWheel;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Skip drawing if canvas is not visible (e.g., display: none)
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return;
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    const fallbackSize = Number(canvas.getAttribute('width')) || 256;
    const cssSize = Math.max(rect.width, rect.height) > 0
      ? Math.min(rect.width || fallbackSize, rect.height || fallbackSize)
      : fallbackSize;

    // Ensure pixelSize is within safe bounds to prevent OOM
    // Max dimension: 4096px (reasonable for canvas operations)
    const MAX_CANVAS_SIZE = 4096;
    let pixelSize = Math.max(1, Math.round(cssSize * dpr));

    // Validate pixelSize is finite and within safe range
    if (!Number.isFinite(pixelSize) || pixelSize > MAX_CANVAS_SIZE || pixelSize < 1) {
      console.warn(`Invalid canvas dimensions calculated: ${pixelSize}. Using fallback.`);
      pixelSize = Math.min(fallbackSize, MAX_CANVAS_SIZE);
    }

    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    } else if (!force && this._colorWheelLastSize && this._colorWheelLastSize.pixelSize === pixelSize && this._colorWheelLastSize.dpr === dpr) {
      return;
    }

    this._colorWheelLastSize = { pixelSize, dpr };

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const radius = pixelSize / 2;
    const imageData = ctx.createImageData(pixelSize, pixelSize);
    const data = imageData.data;

    const hslToRgb = (h, s, l) => {
      if (s === 0) {
        const val = Math.round(l * 255);
        return [val, val, val];
      }
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const r = hue2rgb(p, q, h + 1 / 3);
      const g = hue2rgb(p, q, h);
      const b = hue2rgb(p, q, h - 1 / 3);
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    };

    for (let y = 0; y < pixelSize; y += 1) {
      for (let x = 0; x < pixelSize; x += 1) {
        const dx = x + 0.5 - radius;
        const dy = y + 0.5 - radius;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;

        const sat = Math.min(1, dist / radius);
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const lightness = 0.45 + (1 - sat) * 0.35;
        const [r, g, b] = hslToRgb(hue / 360, sat, lightness);

        const idx = (y * pixelSize + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(radius, radius, radius - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** ---------- Light updates ---------- */
  updateLights() {
    if (!this._hass) return;
    const lights = this.shadowRoot.querySelectorAll('.light');
    lights.forEach(light => {
      const id = light.dataset.entity;
      const st = this._hass.states[id];
      if (!st) return;

      const [domain] = id.split('.');
      const isOn = st.state === 'on';
      const isScene = domain === 'scene';

      const color = this._resolveEntityColor(id, isOn, st.attributes);
      const displayColor = (color && color !== 'transparent') ? color : this._config.switch_off_color;

      light.style.setProperty('--light-color', displayColor);
      light.style.setProperty('--light-icon-color', this._config.icon_only ? displayColor : 'rgba(255,255,255,0.92)');

      if (this._config.icon_only) {
        light.style.background = 'transparent';
      } else if (color !== 'transparent') {
        light.style.background = color;
      } else {
        light.style.background = ''; // Fallback to CSS
      }

      light.classList.toggle('off', !isOn && !isScene);
      light.classList.toggle('on', isOn || isScene);
      light.classList.toggle('icon-only', this._config.icon_only);

      // Ensure selected styling matches current selection set
      const selected = this._selectedLights.has(id);
      light.classList.toggle('selected', selected);
    });

    // Update controls to reflect averaged state
    const shouldShowControls = this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity;
    if (shouldShowControls) {
      const controlContext = this._getControlContext();
      this._updateControlValues(controlContext);
    }
    // Show/hide floating controls if used
    if (this._els.controlsFloating) {
      this._els.controlsFloating.classList.toggle('visible', shouldShowControls);
    }
    // Show/hide below controls if used
    if (this._els.controlsBelow) {
      this._els.controlsBelow.classList.toggle('visible', shouldShowControls);
    }
    if ((this._config.always_show_controls || this._selectedLights.size > 0 || this._config.default_entity) && this._els.colorWheel) {
      this._requestColorWheelDraw();
    }
    this._refreshEntityIcons();
  }

  /** ---------- YAML generation ---------- */
  _generateYAML() {
    const indent = '  ';
    const yamlLines = [`type: custom:spatial-light-color-card`];

    if (this._config.title) yamlLines.push(`title: ${this._config.title}`);
    yamlLines.push(`canvas_height: ${this._config.canvas_height}`);
    yamlLines.push(`grid_size: ${this._config.grid_size}`);
    if (this._config.label_mode) yamlLines.push(`label_mode: ${this._config.label_mode}`);
    yamlLines.push(`show_settings_button: ${this._config.show_settings_button !== false}`);
    yamlLines.push(`always_show_controls: ${!!this._config.always_show_controls}`);
    yamlLines.push(`controls_below: ${!!this._config.controls_below}`);
    yamlLines.push(`show_entity_icons: ${!!this._config.show_entity_icons}`);
    yamlLines.push(`icon_only: ${!!this._config.icon_only}`);
    yamlLines.push(`light_size: ${this._config.light_size}`);
    yamlLines.push(`switch_single_tap: ${!!this._config.switch_single_tap}`);
    yamlLines.push(`icon_style: ${this._config.icon_style}`);
    if (this._config.default_entity) yamlLines.push(`default_entity: ${this._config.default_entity}`);
    if (Number.isFinite(this._config.temperature_min)) yamlLines.push(`temperature_min: ${this._config.temperature_min}`);
    if (Number.isFinite(this._config.temperature_max)) yamlLines.push(`temperature_max: ${this._config.temperature_max}`);

    // Colors
    if (this._config.switch_on_color !== '#ffa500') yamlLines.push(`switch_on_color: "${this._config.switch_on_color}"`);
    if (this._config.switch_off_color !== '#2a2a2a') yamlLines.push(`switch_off_color: "${this._config.switch_off_color}"`);
    if (this._config.scene_color !== '#6366f1') yamlLines.push(`scene_color: "${this._config.scene_color}"`);

    if (this._config.color_overrides && Object.keys(this._config.color_overrides).length) {
      yamlLines.push('color_overrides:');
      Object.entries(this._config.color_overrides).forEach(([entity, val]) => {
        if (typeof val === 'string') {
          yamlLines.push(`${indent}${entity}: "${val}"`);
        } else {
          yamlLines.push(`${indent}${entity}:`);
          if (val.state_on) yamlLines.push(`${indent}${indent}state_on: "${val.state_on}"`);
          if (val.state_off) yamlLines.push(`${indent}${indent}state_off: "${val.state_off}"`);
        }
      });
    }

    if (this._config.label_overrides && Object.keys(this._config.label_overrides).length) {
      yamlLines.push('label_overrides:');
      Object.entries(this._config.label_overrides).forEach(([entity, label]) => {
        yamlLines.push(`${indent}${entity}: ${label}`);
      });
    }

    if (this._config.background_image) {
      const bg = this._config.background_image;
      if (typeof bg === 'string') {
        yamlLines.push(`background_image: ${bg}`);
      } else {
        yamlLines.push('background_image:');
        if (bg.url) yamlLines.push(`${indent}url: ${bg.url}`);
        if (bg.size) yamlLines.push(`${indent}size: ${bg.size}`);
        if (bg.position) yamlLines.push(`${indent}position: ${bg.position}`);
        if (bg.repeat) yamlLines.push(`${indent}repeat: ${bg.repeat}`);
        if (bg.blend_mode) yamlLines.push(`${indent}blend_mode: ${bg.blend_mode}`);
      }
    }

    yamlLines.push('entities:');
    this._config.entities.forEach(ent => { yamlLines.push(`${indent}- ${ent}`); });

    yamlLines.push('positions:');
    Object.entries(this._config.positions).forEach(([ent, pos]) => {
      yamlLines.push(`${indent}${ent}:`);
      yamlLines.push(`${indent}${indent}x: ${Number(pos.x.toFixed ? pos.x.toFixed(2) : pos.x)}`);
      yamlLines.push(`${indent}${indent}y: ${Number(pos.y.toFixed ? pos.y.toFixed(2) : pos.y)}`);
    });

    return `${yamlLines.join('\n')}\n`;
  }

  getCardSize() { return 8; }
  static getStubConfig() {
    return {
      entities: [], positions: {}, title: '',
      canvas_height: 450, grid_size: 25, label_mode: 'smart',
      show_settings_button: true, always_show_controls: false, controls_below: true,
      default_entity: null, show_entity_icons: false, icon_only: false, icon_style: 'mdi',
      light_size: 56,
      switch_on_color: '#ffa500', switch_off_color: '#2a2a2a', scene_color: '#6366f1'
    };
  }
}

customElements.define('spatial-light-color-card', SpatialLightColorCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'spatial-light-color-card',
  name: 'Spatial Light Color Card',
  description: 'Refined spatial light control with intelligent interactions and polished design',
  preview: true,
});
