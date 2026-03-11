export default {
  template: `
    <div ref="container" :style="containerStyle">
      <div ref="viewport" :style="viewportStyle"></div>
    </div>
  `,

  props: {
    spriteSrc:        { type: String, default: null },
    framesSrc:        { type: Array, default: null },
    frameCount:       { type: Number, default: null },
    cols:             { type: Number, default: null },
    frameWidth:       { type: Number, default: null },
    frameHeight:      { type: Number, default: null },
    responsiveMargin: { type: Number, default: 0 },
    dragSensitivity:  { type: Number, default: 8 },
    autoSpin:         { type: Number, default: 0 },
    background:       { type: String, default: 'transparent' },
    containerPadding: { type: Number, default: 1 },
    showBoundary:     { type: Boolean, default: false },
    boundaryColor:    { type: String, default: '#ff3b30' },
    boundaryWidth:    { type: Number, default: 1 },
  },

  data() {
    return {
      resolvedFrameCount: null,
      resolvedCols: null,
      resolvedFrameW: null,
      resolvedFrameH: null,
      parentWidth: 0,
      ready: false,
      currentFrame: 0,
      isDragging: false,
      dragStartX: 0,
      dragAccum: 0,
      spinTimer: null,
      images: [],
      _canvas: null,
      _ctx: null,
      _resizeObs: null,
    };
  },

  computed: {
    outerWidth() {
      return Math.max(1, Math.floor(this.parentWidth - this.responsiveMargin));
    },
    pad() {
      return Math.max(0, this.containerPadding);
    },
    viewportWidth() {
      return Math.max(1, this.outerWidth - 2 * this.pad);
    },
    scale() {
      return this.resolvedFrameW ? this.viewportWidth / this.resolvedFrameW : 1;
    },
    viewportHeight() {
      return this.resolvedFrameH ? Math.max(1, Math.round(this.resolvedFrameH * this.scale)) : 1;
    },
    outerHeight() {
      return this.viewportHeight + 2 * this.pad;
    },
    spriteW() {
      return this.resolvedCols ? Math.round(this.resolvedFrameW * this.resolvedCols * this.scale) : 0;
    },
    spriteH() {
      if (!this.resolvedFrameCount || !this.resolvedCols || !this.resolvedFrameH) return 0;
      const rows = Math.ceil(this.resolvedFrameCount / this.resolvedCols);
      return Math.round(this.resolvedFrameH * rows * this.scale);
    },
    containerStyle() {
      return {
        width: `${this.outerWidth}px`,
        height: `${this.outerHeight}px`,
        padding: `${this.pad}px`,
        boxSizing: 'border-box',
        backgroundColor: this.background,
        overflow: 'hidden',
        visibility: this.ready ? 'visible' : 'hidden',
      };
    },
    viewportStyle() {
      const style = {
        width: `${this.viewportWidth}px`,
        height: `${this.viewportHeight}px`,
        boxSizing: 'border-box',
        userSelect: 'none',
        touchAction: 'none',
        cursor: this.isDragging ? 'grabbing' : 'grab',
        backgroundRepeat: 'no-repeat',
      };

      if (this.showBoundary) {
        style.border = `${Math.max(1, this.boundaryWidth)}px solid ${this.boundaryColor}`;
      }

      if (this.spriteSrc && this.ready) {
        const col = this.currentFrame % this.resolvedCols;
        const row = Math.floor(this.currentFrame / this.resolvedCols);
        style.backgroundImage = `url('${this.spriteSrc}')`;
        style.backgroundSize = `${this.spriteW}px ${this.spriteH}px`;
        style.backgroundPosition = `${-(col * this.viewportWidth)}px ${-(row * this.viewportHeight)}px`;
      }

      return style;
    },
  },

  watch: {
    viewportWidth() {
      this._syncCanvasSize();
    },
    viewportHeight() {
      this._syncCanvasSize();
    },
  },

  async mounted() {
    await this._resolveGeometry();

    if (this.spriteSrc) {
      await this._loadSprite();
    } else if (this.framesSrc) {
      this._canvas = document.createElement('canvas');
      this._canvas.style.display = 'block';
      this.$refs.viewport.appendChild(this._canvas);
      this._ctx = this._canvas.getContext('2d');
      await this._loadSequence();
    }

    this._setupResizeObserver();
    this._syncCanvasSize();

    this.ready = true;
    if (this._ctx) this._drawFrame(0);
    if (this.autoSpin > 0 && this.resolvedFrameCount > 0) this._startSpin();

    this.$refs.viewport.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  },

  beforeUnmount() {
    this.$refs.viewport.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this._stopSpin();
    if (this._resizeObs) this._resizeObs.disconnect();
  },

  methods: {
    async _resolveGeometry() {
      if (
        this.frameCount !== null &&
        this.cols !== null &&
        this.frameWidth !== null &&
        this.frameHeight !== null
      ) {
        this.resolvedFrameCount = this.frameCount;
        this.resolvedCols = this.cols;
        this.resolvedFrameW = this.frameWidth;
        this.resolvedFrameH = this.frameHeight;
        return;
      }

      if (!this.spriteSrc) return;
      const meta = await this._readXmp(this.spriteSrc);
      this.resolvedFrameCount = this.frameCount ?? meta.frame_count ?? null;
      this.resolvedCols = this.cols ?? meta.cols ?? null;
      this.resolvedFrameW = this.frameWidth ?? meta.frame_width ?? null;
      this.resolvedFrameH = this.frameHeight ?? meta.frame_height ?? null;
    },

    _setupResizeObserver() {
      const target = this._pickResizeTarget();
      const update = entries => {
        const observed = entries && entries[0] ? entries[0].contentRect.width : target.clientWidth;
        const width = Math.floor(observed);
        if (width > 0) this.parentWidth = width;
      };
      this._resizeObs = new ResizeObserver(update);
      this._resizeObs.observe(target);
      update();
      requestAnimationFrame(update);
      setTimeout(update, 80);
    },

    _pickResizeTarget() {
      const self = this.$el;
      const card = self.closest('.q-card');
      if (card) return card;

      const selfWidth = Math.floor(self.getBoundingClientRect().width || 0);
      let candidate = self.parentElement;
      while (candidate && candidate !== document.body) {
        const width = Math.floor(candidate.getBoundingClientRect().width || 0);
        if (width > 0 && Math.abs(width - selfWidth) > 1) return candidate;
        candidate = candidate.parentElement;
      }
      return self.parentElement || self;
    },

    _syncCanvasSize() {
      if (!this._canvas || !this._ctx) return;
      const width = this.viewportWidth;
      const height = this.viewportHeight;
      if (this._canvas.width !== width || this._canvas.height !== height) {
        this._canvas.width = width;
        this._canvas.height = height;
      }
      this._canvas.style.width = `${width}px`;
      this._canvas.style.height = `${height}px`;
      if (this.ready && this.images.length > 0) this._drawFrame(this.currentFrame);
    },

    async _readXmp(url) {
      try {
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const text = new TextDecoder().decode(new Uint8Array(buf));
        const marker = '<x:xmpmeta';
        const end = '</x:xmpmeta>';
        const start = text.indexOf(marker);
        const finish = text.indexOf(end);
        if (start === -1 || finish === -1) return {};

        const xmp = text.slice(start, finish + end.length);
        const fields = ['frame_count', 'cols', 'frame_width', 'frame_height'];
        const meta = {};
        for (const field of fields) {
          const match = xmp.match(new RegExp(`<p360:${field}>(\\d+)</p360:${field}>`));
          if (match) meta[field] = parseInt(match[1], 10);
        }
        return meta;
      } catch {
        return {};
      }
    },

    _loadSprite() {
      return new Promise(resolve => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = this.spriteSrc;
      });
    },

    _loadSequence() {
      return new Promise(resolve => {
        let loaded = 0;
        this.images = this.framesSrc.map(src => {
          const img = new Image();
          const done = () => {
            loaded += 1;
            if (loaded === this.framesSrc.length) resolve();
          };
          img.onload = done;
          img.onerror = done;
          img.src = src;
          return img;
        });
      });
    },

    showFrame(index) {
      if (!this.resolvedFrameCount) return;
      this.currentFrame = ((index % this.resolvedFrameCount) + this.resolvedFrameCount) % this.resolvedFrameCount;
      if (this._ctx) this._drawFrame(this.currentFrame);
    },

    _drawFrame(index) {
      const img = this.images[index];
      if (!img) return;
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.drawImage(img, 0, 0, this._canvas.width, this._canvas.height);
    },

    _startSpin() {
      const msPerFrame = (60 * 1000) / (this.autoSpin * this.resolvedFrameCount);
      this.spinTimer = setInterval(() => this.showFrame(this.currentFrame + 1), msPerFrame);
    },

    _stopSpin() {
      if (!this.spinTimer) return;
      clearInterval(this.spinTimer);
      this.spinTimer = null;
    },

    _startDrag(clientX) {
      this._stopSpin();
      this.isDragging = true;
      this.dragStartX = clientX;
      this.dragAccum = 0;
    },

    _moveDrag(clientX) {
      if (!this.isDragging) return;
      this.dragAccum += clientX - this.dragStartX;
      this.dragStartX = clientX;
      const stepPx = Math.max(1, this.dragSensitivity);
      const steps = Math.trunc(this.dragAccum / stepPx);
      if (steps === 0) return;
      this.showFrame(this.currentFrame + steps);
      this.dragAccum -= steps * stepPx;
    },

    _endDrag() {
      this.isDragging = false;
    },

    _onPointerDown(event) {
      this._startDrag(event.clientX);
      event.preventDefault();
    },

    _onPointerMove(event) {
      this._moveDrag(event.clientX);
    },

    _onPointerUp() {
      this._endDrag();
    },
  },
};
