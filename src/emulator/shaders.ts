import { SCREEN_HEIGHT, SCREEN_WIDTH } from './sm8521';
import { ShaderId } from './types';

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform int u_shaderMode;
uniform float u_intensity;
uniform vec2 u_texSize;
uniform vec2 u_outSize;

in vec2 v_uv;
out vec4 outColor;

vec2 applyCurvature(vec2 uv, float amt) {
  vec2 c = uv * 2.0 - 1.0;
  vec2 offset = abs(c.yx) / vec2(6.5, 5.2);
  c = c + c * offset * offset * amt;
  return c * 0.5 + 0.5;
}

void main() {
  vec2 uv = v_uv;

  // Mode 3: CRT Scanlines & subtle curvature
  if (u_shaderMode == 3) {
    uv = applyCurvature(uv, 0.55 * u_intensity);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      outColor = vec4(0.04, 0.05, 0.06, 1.0);
      return;
    }
  }

  // Sample crisp texel
  vec2 pixelCoord = uv * u_texSize;
  vec2 texel = floor(pixelCoord);
  vec2 f = fract(pixelCoord);
  vec2 nearestUv = (texel + 0.5) / u_texSize;
  vec3 col = texture(u_tex, nearestUv).rgb;

  // Mode 0: Raw Nearest Pixel
  if (u_shaderMode == 0) {
    outColor = vec4(col, 1.0);
    return;
  }

  // Mode 1: Dot Matrix LCD (1997 passive-matrix grid)
  if (u_shaderMode == 1) {
    float gapX = smoothstep(0.0, 0.14, f.x) * (1.0 - smoothstep(0.86, 1.0, f.x));
    float gapY = smoothstep(0.0, 0.14, f.y) * (1.0 - smoothstep(0.86, 1.0, f.y));
    float cell = mix(1.0, gapX * gapY, 0.35 * u_intensity);
    // Slight dark border in gaps
    col = mix(col * 0.72, col, cell);
    outColor = vec4(col, 1.0);
    return;
  }

  // Mode 2: STN Shadow Layer (pixel drop shadow onto reflective LCD backing)
  if (u_shaderMode == 2) {
    vec2 shadowUv = clamp((texel + vec2(-1.0, -1.0) + 0.5) / u_texSize, 0.0, 1.0);
    vec3 nw = texture(u_tex, shadowUv).rgb;
    float nwDarkness = 1.0 - dot(nw, vec3(0.333));
    float cellX = smoothstep(0.0, 0.12, f.x) * (1.0 - smoothstep(0.88, 1.0, f.x));
    float cellY = smoothstep(0.0, 0.12, f.y) * (1.0 - smoothstep(0.88, 1.0, f.y));
    float grid = mix(1.0, cellX * cellY, 0.28 * u_intensity);
    col = col * (1.0 - nwDarkness * 0.16 * u_intensity);
    col = mix(col * 0.78, col, grid);
    outColor = vec4(col, 1.0);
    return;
  }

  // Mode 3: CRT Scanlines + subtle bloom + vignette
  if (u_shaderMode == 3) {
    // Soft horizontal neighbor tap for subtle phosphor bloom
    vec3 left = texture(u_tex, clamp(nearestUv - vec2(1.0 / u_texSize.x, 0.0), 0.0, 1.0)).rgb;
    vec3 right = texture(u_tex, clamp(nearestUv + vec2(1.0 / u_texSize.x, 0.0), 0.0, 1.0)).rgb;
    col = mix(col, (col * 0.7 + left * 0.15 + right * 0.15), 0.5 * u_intensity);

    float scan = sin(uv.y * u_texSize.y * 3.14159265 * 2.0);
    float scanFactor = 1.0 - (0.28 * u_intensity * (0.5 - 0.5 * scan));
    col *= scanFactor;

    // Subtle aperture grille
    float mask = 1.0 - 0.08 * u_intensity * step(0.5, fract(gl_FragCoord.x * 0.5));
    col *= mask;

    // Corner vignette
    vec2 vig = uv * (1.0 - uv.yx);
    float v = clamp(pow(vig.x * vig.y * 15.0, 0.22 * u_intensity), 0.65, 1.0);
    col *= v;

    outColor = vec4(col, 1.0);
    return;
  }

  // Mode 4: Backlit Diffuser (warm glow + gentle neighbor bleed)
  if (u_shaderMode == 4) {
    vec3 avg = (
      texture(u_tex, clamp(uv + vec2(0.5 / u_texSize.x, 0.0), 0.0, 1.0)).rgb +
      texture(u_tex, clamp(uv - vec2(0.5 / u_texSize.x, 0.0), 0.0, 1.0)).rgb +
      texture(u_tex, clamp(uv + vec2(0.0, 0.5 / u_texSize.y), 0.0, 1.0)).rgb +
      texture(u_tex, clamp(uv - vec2(0.0, 0.5 / u_texSize.y), 0.0, 1.0)).rgb
    ) * 0.25;
    col = mix(col, avg, 0.45 * u_intensity);
    float edgeDist = length(uv - 0.5);
    float glow = 1.0 + (0.14 - edgeDist * 0.28) * u_intensity;
    col = clamp(col * glow, 0.0, 1.0);
    outColor = vec4(col, 1.0);
    return;
  }

  // Mode 5: Bilinear Smooth (custom smoothstep interpolation for crisp large scaling)
  vec2 i = floor(pixelCoord - 0.5);
  vec2 w = smoothstep(0.0, 1.0, fract(pixelCoord - 0.5));
  vec3 c00 = texture(u_tex, clamp((i + vec2(0.5, 0.5)) / u_texSize, 0.0, 1.0)).rgb;
  vec3 c10 = texture(u_tex, clamp((i + vec2(1.5, 0.5)) / u_texSize, 0.0, 1.0)).rgb;
  vec3 c01 = texture(u_tex, clamp((i + vec2(0.5, 1.5)) / u_texSize, 0.0, 1.0)).rgb;
  vec3 c11 = texture(u_tex, clamp((i + vec2(1.5, 1.5)) / u_texSize, 0.0, 1.0)).rgb;
  vec3 smoothCol = mix(mix(c00, c10, w.x), mix(c01, c11, w.x), w.y);
  col = mix(col, smoothCol, u_intensity);
  outColor = vec4(col, 1.0);
}
`;

function shaderIdToMode(id: ShaderId): number {
  switch (id) {
    case 'sharp': return 0;
    case 'dot-matrix': return 1;
    case 'stn-shadow': return 2;
    case 'crt-scanline': return 3;
    case 'backlight-glow': return 4;
    case 'smooth-scale': return 5;
  }
}

export class LcdShaderRenderer {
  private displayCanvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTexLoc: WebGLUniformLocation | null = null;
  private uModeLoc: WebGLUniformLocation | null = null;
  private uIntensityLoc: WebGLUniformLocation | null = null;
  private uTexSizeLoc: WebGLUniformLocation | null = null;
  private uOutSizeLoc: WebGLUniformLocation | null = null;
  private fallback2d: CanvasRenderingContext2D | null = null;

  public attach(canvas: HTMLCanvasElement | null): void {
    this.cleanupGl();
    this.displayCanvas = canvas;
    if (!canvas) return;

    // Render target resolution (3x native = 600x480 for crisp subpixel & scanline shaders)
    canvas.width = SCREEN_WIDTH * 3;
    canvas.height = SCREEN_HEIGHT * 3;

    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (gl && this.initGl(gl)) {
      this.gl = gl;
      this.fallback2d = null;
    } else {
      this.gl = null;
      this.fallback2d = canvas.getContext('2d');
      if (this.fallback2d) {
        this.fallback2d.imageSmoothingEnabled = false;
      }
    }
  }

  private initGl(gl: WebGL2RenderingContext): boolean {
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return false;

    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return false;
    }

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );

    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.program = prog;
    this.vao = vao;
    this.texture = tex;
    this.uTexLoc = gl.getUniformLocation(prog, 'u_tex');
    this.uModeLoc = gl.getUniformLocation(prog, 'u_shaderMode');
    this.uIntensityLoc = gl.getUniformLocation(prog, 'u_intensity');
    this.uTexSizeLoc = gl.getUniformLocation(prog, 'u_texSize');
    this.uOutSizeLoc = gl.getUniformLocation(prog, 'u_outSize');
    return true;
  }

  public render(
    sourceCanvas: HTMLCanvasElement,
    shaderId: ShaderId,
    intensity: number
  ): void {
    if (!this.displayCanvas) return;

    if (this.gl && this.program && this.texture && this.vao) {
      const gl = this.gl;
      gl.viewport(0, 0, this.displayCanvas.width, this.displayCanvas.height);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

      gl.uniform1i(this.uTexLoc, 0);
      gl.uniform1i(this.uModeLoc, shaderIdToMode(shaderId));
      gl.uniform1f(this.uIntensityLoc, intensity);
      gl.uniform2f(this.uTexSizeLoc, SCREEN_WIDTH, SCREEN_HEIGHT);
      gl.uniform2f(this.uOutSizeLoc, this.displayCanvas.width, this.displayCanvas.height);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }

    if (this.fallback2d) {
      this.fallback2d.imageSmoothingEnabled = shaderId === 'smooth-scale';
      this.fallback2d.drawImage(
        sourceCanvas,
        0,
        0,
        this.displayCanvas.width,
        this.displayCanvas.height
      );
    }
  }

  private cleanupGl(): void {
    if (this.gl) {
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.vao) this.gl.deleteVertexArray(this.vao);
    }
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.vao = null;
    this.fallback2d = null;
  }

  public destroy(): void {
    this.cleanupGl();
    this.displayCanvas = null;
  }
}
