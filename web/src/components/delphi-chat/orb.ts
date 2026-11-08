// DELPHI's orb for the chat: one liquid-glass blob drawn by a WebGL fragment shader on a canvas fixed
// over the page, shading only the box around it (scissor), so it's cheap even when it's 15px wide.
// The same light as /upload's orb (upload/orb-shader.ts), without the bubbles and the data grids, plus
// a stretch along the way it's moving and a softer core for when it's tiny.
//
// Uniforms: uC centre and uR radius in CSS px; uThink 0 = a waveform (listening, writing), 1 = loops
// (thinking); uEnergy how lively the light is; uSq = (stretch, cos, sin) of the direction it's moving;
// uTiny 1 when it's a bead, so the light pools into a glow instead of hairline strands.

const VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

const FRAGMENT = `precision highp float;
uniform vec2 uRes;uniform float uDpr;uniform float uTime;uniform float uFade;uniform float uShadow;
uniform vec2 uC;uniform float uR;uniform float uThink;uniform float uEnergy;uniform float uPulse;
uniform vec3 uSq;uniform float uTiny;
const vec3 K0=vec3(0.974,0.789,0.440);
const vec3 K1=vec3(1.000,0.596,0.347);
const vec3 K2=vec3(0.986,0.482,0.624);
const vec3 K3=vec3(0.669,0.458,0.873);
const vec3 K4=vec3(0.327,0.506,0.900);
const vec3 K5=vec3(0.583,0.833,0.965);
vec3 hue(float s){
 s=clamp(s,0.,1.);
 if(s<0.2)return mix(K0,K1,s/0.2);
 if(s<0.45)return mix(K1,K2,(s-0.2)/0.25);
 if(s<0.65)return mix(K2,K3,(s-0.45)/0.2);
 if(s<0.82)return mix(K3,K4,(s-0.65)/0.17);
 return mix(K4,K5,(s-0.82)/0.18);
}
float hueField(vec2 uv,float t,float open){
 float sH=smoothstep(-0.8,0.8,uv.x+0.12*sin(t*0.45));
 float sA=0.5+0.5*sin(atan(uv.y,uv.x)+t*0.2);
 return mix(sH,sA,open);
}
float smin(float a,float b,float k){float h=clamp(0.5+0.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*vn(p);p=p*2.02+vec2(1.7,9.2);a*=.5;}return v;}
float blob(vec2 p,float r,float t){
 p=vec2(uSq.y*p.x+uSq.z*p.y,-uSq.z*p.x+uSq.y*p.y);p.x/=(1.+uSq.x);p.y/=(1.-0.4*uSq.x);
 float a=atan(p.y,p.x);
 float k=0.010+0.012*uThink+0.012*uPulse;
 float w=k*(sin(3.*a+t*0.5)+0.7*sin(2.*a-t*0.37+1.3)+0.4*sin(5.*a+t*0.8+2.1));
 float d=length(p)-r*(1.+w);
 float s=0.3+0.7*uThink;
 float a1=t*0.42,a2=-t*0.32+2.1,a3=t*0.24+4.2;
 float sr=r*0.30*s,kk=r*0.24;
 d=smin(d,length(p-r*0.62*vec2(cos(a1),sin(a1)))-sr,kk);
 d=smin(d,length(p-r*0.60*vec2(cos(a2),sin(a2)))-sr*0.92,kk);
 d=smin(d,length(p-r*0.58*vec2(cos(a3),sin(a3)))-sr*0.84,kk);
 return d;
}
void strands(vec2 uv,float t,float e,float open,out float core,out float gS,out float gL){
 core=0.;gS=0.;gL=0.;
 for(int i=0;i<4;i++){
  float fi=float(i);
  float dir=mod(fi,2.)<0.5?1.:-1.;
  float rot=open*(fi*0.785+t*(0.17+0.06*fi)*dir);
  float cs=cos(rot),sn=sin(rot);
  vec2 q=vec2(cs*uv.x+sn*uv.y,-sn*uv.x+cs*uv.y);
  float a=0.70+0.04*sin(t*0.5+fi)-0.14*open;
  float b=max(a*open*(0.2+0.55*abs(sin(t*(0.25+0.08*fi)+fi*1.3))),0.014);
  float env=exp(-q.x*q.x*3.6);
  float amp=(0.03+0.24*e)*(0.55+0.45*sin(t*(0.8+0.21*fi)+fi*2.1))*(1.-0.75*open);
  q.y-=0.09*(1.-open)+amp*env*sin(q.x*(4.6+1.6*fi)+t*(1.8+0.45*fi)+fi*1.9);
  vec2 k=q/vec2(a,b);
  float lk=max(length(k),1e-4);
  float th=atan(k.y,k.x);
  float wob=open*0.09*sin(3.*th+t*(0.6+0.1*fi)+fi*2.)+open*0.05*sin(5.*th-t*0.5+fi);
  vec2 gr=q/vec2(a*a,b*b)/lk;
  float dd=(lk-1.-wob)/max(length(gr),1e-4);
  float front=0.5+0.5*sin(th);
  float head=t*(0.7+0.15*fi)*dir;
  float dth=mod(dir*(head-th),6.28318);
  float comet=exp(-dth*0.9)+exp(-(6.28318-dth)*6.);
  float lineE=mix(env,1.,open)*mix(1.,smoothstep(0.3,0.68,lk)*(1.-smoothstep(1.7,2.6,lk)),open);
  float bright=mix(1.,(0.3+0.9*comet)*(0.45+0.7*front),open);
  float gb=mix(1.,0.5+0.3*front,open);
  float w=0.009+0.008*e+0.008*open;
  core+=exp(-dd*dd/(w*w))*lineE*bright;
  gS+=exp(-dd*dd/(0.0035+0.008*e+0.010*open))*lineE*gb;
  gL+=exp(-dd*dd/(0.03+0.05*e+0.05*open))*lineE*mix(1.,0.8,open);
 }
}
vec3 orbLight(vec2 uv,float t,float think,float energy){
 float r2=dot(uv,uv);
 vec2 uvL=uv*mix(0.84,1.,clamp(r2,0.,1.));
 float core,gS,gL;
 strands(uvL,t,energy,think,core,gS,gL);
 float sF=hueField(uvL,t,think);
 vec3 hc=hue(sF);
 hc=mix(hc,K2,exp(-uvL.x*uvL.x/0.10)*smoothstep(-0.02,0.22,uvL.y-0.09)*(1.-think)*0.65);
 vec3 nebC=vec3(0.);float cg=0.;
 if(think>0.001){
  vec2 q=vec2(fbm(uvL*1.5+vec2(0.,t*0.10)),fbm(uvL*1.5+vec2(5.2,-t*0.09)));
  vec2 rr=vec2(fbm(uvL*1.8+3.*q+vec2(1.7,9.2)+t*0.07),fbm(uvL*1.8+3.*q+vec2(8.3,2.8)-t*0.06));
  float f=fbm(uvL*1.3+2.6*rr);
  float neb=smoothstep(0.4,0.85,f)*smoothstep(0.98,0.15,length(uvL));
  nebC=hue(clamp(sF+0.35*(rr.x-rr.y),0.,1.))*neb;
  cg=exp(-dot(uvL,uvL)/0.09);
 }
 vec3 light=vec3(1.)*core*0.80*(1.-0.75*uTiny)+mix(vec3(1.),hc,0.74)*gS*0.44+hc*gL*mix(0.36,0.22,think);
 light+=(nebC*0.26+mix(vec3(1.),hc,0.55)*cg*0.30)*think;
 vec2 g0=uvL+vec2(0.,-0.08);
 light+=mix(vec3(1.),hc,0.62)*exp(-dot(g0,g0)/0.13)*(0.75+0.5*energy)*uTiny;
 return light;
}
float scene(vec2 fc,float t){return blob(fc-uC,uR,t);}
void main(){
 vec2 fc=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr;
 float t=uTime;
 float d=scene(fc,t);
 float dither=(hash(fc*1.37+fract(t))-0.5)/255.;
 float r0=min(uR,170.);
 float ds=blob(fc-uC-vec2(0.,0.17*r0),uR,t)+0.05*r0;
 float sh=max((0.21*exp(-max(ds,0.)/(0.15*r0))+0.05*exp(-max(ds,0.)/(0.4*r0)))*smoothstep(4.,40.,uR)+dither,0.)*(1.-smoothstep(0.8*r0,1.2*r0,max(ds,0.)))*uShadow;
 if(d>1.5){gl_FragColor=vec4(0.,0.,0.,sh*uFade);return;}
 float a=clamp(0.5-d*uDpr,0.,1.);
 vec2 g=vec2(scene(fc+vec2(1.,0.),t)-scene(fc-vec2(1.,0.),t),scene(fc+vec2(0.,1.),t)-scene(fc-vec2(0.,1.),t));
 g=g/max(length(g),1e-5);
 float inside=max(-d,0.);
 float x=clamp(inside/max(min(uR*0.45,120.),1.),0.,1.);
 vec3 n=normalize(vec3(g*pow(1.-x,2.)*2.4,1.));
 vec3 L=normalize(vec3(-0.45,-0.85,0.65));
 float fres=pow(clamp(1.-n.z,0.,1.),1.6);
 float spec=pow(max(dot(reflect(vec3(0.,0.,-1.),n),L),0.),70.);
 vec2 uv=(fc-uC)/max(uR,1.);
 vec3 body=mix(vec3(0.016),vec3(0.05),smoothstep(0.15,1.,clamp(0.5+0.5*uv.y,0.,1.)));
 float bottomness=smoothstep(-0.3,1.,g.y);
 vec3 col=mix(body,vec3(0.6),fres*(0.26+0.5*bottomness));
 vec3 light=orbLight(uv,t,uThink,uEnergy)*(1.+0.25*uPulse);
 light*=smoothstep(0.,0.3*r0,inside);
 light+=hue(0.5+0.4*clamp(uv.x,-1.,1.))*exp(-inside/(0.07*r0+1.))*bottomness*(0.12+0.35*uEnergy+0.25*uThink);
 float lum=max(light.r,max(light.g,light.b));
 light=mix(light,vec3(lum),smoothstep(1.1,2.6,lum)*0.45);
 light=1.-exp(-light*1.1);
 float facing=max(dot(g,normalize(vec2(-0.45,-0.89))),0.);
 col+=vec3(1.)*exp(-inside*inside/1.1)*(0.16+0.6*facing+0.32*max(g.y,0.))*(1.-0.6*uTiny);
 col+=vec3(1.)*spec*0.85;
 col+=vec3(smoothstep(0.,1.,-g.y)*exp(-inside/(0.16*r0+1.))*0.09)+light+dither;
 gl_FragColor=vec4(col*a,a+sh*(1.-a))*uFade;
}`;

const NAMES = ["uRes", "uDpr", "uTime", "uFade", "uShadow", "uC", "uR", "uThink", "uEnergy", "uPulse", "uSq", "uTiny"] as const;
type Name = (typeof NAMES)[number];
type Resources = { u: Record<Name, WebGLUniformLocation | null>; program: WebGLProgram; buffer: WebGLBuffer };

export type OrbState = {
  x: number;
  y: number;
  r: number;
  think: number;
  energy: number;
  pulse: number;
  /** How far it's stretched along the way it moves (0 to about 0.12), and that direction. */
  stretch: number;
  angle: number;
  time: number;
  fade: number;
  shadow?: number;
};

export class ChatOrb {
  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
    private resources: Resources | null,
    private readonly availability?: (ready: boolean) => void,
  ) {
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private onLost = (event: Event) => {
    event.preventDefault();
    this.resources = null;
    this.availability?.(false);
  };

  private onRestored = () => {
    this.resources = ChatOrb.resources(this.gl);
    this.availability?.(!!this.resources);
  };

  /** Null without WebGL: the page then shows a still bead instead. */
  static create(canvas: HTMLCanvasElement, availability?: (ready: boolean) => void): ChatOrb | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    const resources = ChatOrb.resources(gl);
    return resources ? new ChatOrb(canvas, gl, resources, availability) : null;
  }

  private static resources(gl: WebGLRenderingContext): Resources | null {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
      gl.deleteShader(sh);
      return null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT) ?? compile(gl.FRAGMENT_SHADER, FRAGMENT.replace("precision highp float;", "precision mediump float;"));
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (prog) gl.deleteProgram(prog);
      return null;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    gl.useProgram(prog);
    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(prog);
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {} as Record<Name, WebGLUniformLocation | null>;
    for (const n of NAMES) u[n] = gl.getUniformLocation(prog, n);
    gl.clearColor(0, 0, 0, 0);
    return { u, program: prog, buffer };
  }

  get lost() {
    return !this.resources || this.gl.isContextLost();
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (this.resources) {
      this.gl.deleteProgram(this.resources.program);
      this.gl.deleteBuffer(this.resources.buffer);
      this.resources = null;
    }
  }

  draw(o: OrbState, w: number, h: number, dpr: number) {
    if (this.lost || !this.resources) return;
    const { gl, canvas } = this;
    const { u } = this.resources;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (o.r < 0.5 || o.fade <= 0) return;
    // The orb, its glow and its soft shadow, which fades out by about 1.3 radii and sits a little low.
    const m = Math.max(o.r * 1.3, 24) + o.r * o.stretch;
    const x0 = Math.max(0, Math.floor((o.x - o.r - m) * dpr));
    const x1 = Math.min(cw, Math.ceil((o.x + o.r + m) * dpr));
    const y0 = Math.max(0, Math.floor((o.y - o.r - m) * dpr));
    const y1 = Math.min(ch, Math.ceil((o.y + o.r + m + o.r * 0.2) * dpr));
    if (x1 <= x0 || y1 <= y0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, ch - y1, x1 - x0, y1 - y0);
    gl.uniform2f(u.uRes, cw, ch);
    gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uTime, o.time);
    gl.uniform1f(u.uFade, o.fade);
    gl.uniform1f(u.uShadow, o.shadow ?? 1);
    gl.uniform2f(u.uC, o.x, o.y);
    gl.uniform1f(u.uR, o.r);
    gl.uniform1f(u.uThink, o.think);
    gl.uniform1f(u.uEnergy, o.energy);
    gl.uniform1f(u.uPulse, o.pulse);
    gl.uniform3f(u.uSq, o.stretch, Math.cos(o.angle), Math.sin(o.angle));
    // A bead's light pools into a glow; from about 26px across it shows its strands.
    const tiny = 1 - Math.min(1, Math.max(0, (o.r - 7) / 19));
    gl.uniform1f(u.uTiny, tiny * tiny * (3 - 2 * tiny));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
