// DELPHI's orb, drawn in one fragment shader pass (WebGL 1).
//
// The main orb is a signed-distance blob with three metaball "satellites"; up to seven field bubbles
// merge with it as it splits. Each blob is dark liquid glass: a bevel, fresnel rim, one specular
// highlight and a contact shadow. Inside, DELPHI's light is four white-hot strands whose glow takes
// one shared palette (gold, orange, pink, purple, deep blue, ice), plus the data the read condenses:
// halftone dots (B), hex digits (C) and the lattice globe (D). Grid types: 0 light, 1 halftone, 2 hex,
// 3 globe, 4 bars, 5 ledger, 6 the read (B and C together, then D), 7 B and C only.
//
// Uniforms: uB[i] = (x, y, radius, type), uP[i] = (think, energy, squash, squash angle),
// uQ[i] = (time offset, flash, data mix, grid amount). Positions are CSS pixels from the top left.

export const ORB_VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

export const ORB_FRAGMENT = `precision highp float;
uniform vec2 uRes;uniform float uDpr;uniform float uTime;uniform float uFade;uniform float uK;
uniform vec2 uC;uniform float uR;uniform float uDrop;uniform float uThink;uniform float uEnergy;uniform float uPulse;
uniform float uDots;uniform float uMix;uniform vec3 uBloom;uniform float uGlobe;uniform float uProg;uniform float uMainGrid;
uniform float uN;uniform vec4 uB[7];uniform vec4 uP[7];uniform vec4 uQ[7];uniform float uKm;
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
float font(float d){
 if(d<0.5)return 31599.;if(d<1.5)return 11415.;if(d<2.5)return 29671.;if(d<3.5)return 29647.;
 if(d<4.5)return 23497.;if(d<5.5)return 31183.;if(d<6.5)return 31215.;if(d<7.5)return 29257.;
 if(d<8.5)return 31727.;if(d<9.5)return 31695.;if(d<10.5)return 31725.;if(d<11.5)return 27566.;
 if(d<12.5)return 31015.;if(d<13.5)return 27502.;if(d<14.5)return 31207.;return 31204.;
}
float glyphOn(float dg,vec2 px){
 if(px.x>2.5||px.y>4.5)return 0.;
 float code=font(dg);float idx=(4.-px.y)*3.+(2.-px.x);
 return mod(floor(code/exp2(idx)),2.);
}
float blobMain(vec2 p,float r,float t){
 p.y/=(1.+0.5*uDrop);p.x/=(1.-0.2*uDrop);
 float a=atan(p.y,p.x);
 float k=0.010+0.012*uThink+0.012*uPulse;
 float w=k*(sin(3.*a+t*0.5)+0.7*sin(2.*a-t*0.37+1.3)+0.4*sin(5.*a+t*0.8+2.1));
 float d=length(p)-r*(1.+w);
 float s=0.3+0.7*uThink;
 float a1=t*0.42,a2=-t*0.32+2.1,a3=t*0.24+4.2;
 vec2 c1=r*0.62*vec2(cos(a1),sin(a1));
 vec2 c2=r*0.60*vec2(cos(a2),sin(a2));
 vec2 c3=r*0.58*vec2(cos(a3),sin(a3));
 float sr=r*0.30*s,kk=r*0.24;
 d=smin(d,length(p-c1)-sr,kk);
 d=smin(d,length(p-c2)-sr*0.92,kk);
 d=smin(d,length(p-c3)-sr*0.84,kk);
 return d;
}
float blobField(vec2 p,float r,float t,float sq,float sa){
 float cs=cos(sa),sn=sin(sa);
 vec2 q=vec2(cs*p.x+sn*p.y,-sn*p.x+cs*p.y);
 q.x/=(1.-sq);q.y/=(1.+0.45*sq);
 float a=atan(q.y,q.x);
 float w=0.016*(sin(3.*a+t*0.55)+0.7*sin(2.*a-t*0.41+1.3)+0.4*sin(5.*a+t*0.83+2.1));
 return length(q)-r*(1.+w);
}
float sceneD(vec2 fc,float t){
 float dF=1e4;
 float dM=uR>0.5?blobMain(fc-uC,uR,t):1e4;
 float dJ=dM;
 for(int i=0;i<7;i++){
  if(float(i)<uN){
   vec4 b=uB[i];
   if(b.z>0.5){
    float di=blobField(fc-b.xy,b.z,t+uQ[i].x,uP[i].z,uP[i].w);
    dF=smin(dF,di,uK);
    if(uR>0.5)dJ=min(dJ,smin(dM,di,min(uKm,b.z*1.2)));
   }
  }
 }
 return min(dF,dJ);
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
vec3 orbLight(vec2 fc,vec2 C,float R,float t,float type,float think,float energy,float prog,float dots,float mixv,vec3 bloom,float globe,float gridAmt){
 vec2 uv=(fc-C)/max(R,1.);
 float r2=dot(uv,uv);
 vec2 uvL=uv*mix(0.84,1.,clamp(r2,0.,1.));
 float core,gS,gL;
 strands(uvL,t,energy,think,core,gS,gL);
 float sF=hueField(uvL,t,think);
 vec3 hc=hue(sF);
 float pinkW=exp(-uvL.x*uvL.x/0.10)*smoothstep(-0.02,0.22,uvL.y-0.09)*(1.-think);
 hc=mix(hc,K2,pinkW*0.65);
 float neb=0.;vec3 nebC=vec3(0.);float cg=0.;
 if(think>0.001){
  vec2 q=vec2(fbm(uvL*1.5+vec2(0.,t*0.10)),fbm(uvL*1.5+vec2(5.2,-t*0.09)));
  vec2 rr=vec2(fbm(uvL*1.8+3.*q+vec2(1.7,9.2)+t*0.07),fbm(uvL*1.8+3.*q+vec2(8.3,2.8)-t*0.06));
  float f=fbm(uvL*1.3+2.6*rr);
  neb=smoothstep(0.4,0.85,f)*smoothstep(0.98,0.15,length(uvL));
  nebC=hue(clamp(sF+0.35*(rr.x-rr.y),0.,1.))*neb;
  cg=exp(-dot(uvL,uvL)/0.09);
 }
 float lightI=clamp(core*0.55+gS*0.9+gL*0.45,0.,3.);
 float liSoft=clamp(mix(gS*0.55+gL*0.75,neb*1.05+exp(-dot(uvL,uvL)/0.16)*0.95*think+gL*0.22,0.85*dots),0.,2.);
 float coreK=1.;float haloK=1.;vec3 gcol=vec3(0.);
 float hasGrid=step(0.5,type)*gridAmt;
 if(hasGrid>0.001){
  vec2 uvC=uv*mix(0.80,1.,clamp(r2,0.,1.));
  float pxu=1./max(R,1.);
  float fade=smoothstep(0.97,0.68,sqrt(r2));
  float ck=1.;float hk=1.;
  if(type>5.5){
   float rr2=sqrt(r2)/0.93;
   float zS=sqrt(max(1.-rr2*rr2,0.));
   vec2 sUV=uvC;
   if(globe>0.001){
    vec3 P=vec3(uv/0.93,zS);
    float ay=t*0.12;float ca=cos(ay),sa=sin(ay);
    P=vec3(ca*P.x+sa*P.z,P.y,-sa*P.x+ca*P.z);
    float cb=cos(0.36),sb=sin(0.36);
    P=vec3(P.x,cb*P.y-sb*P.z,sb*P.y+cb*P.z);
    sUV=vec2(atan(P.x,P.z),asin(clamp(P.y,-1.,1.)))*0.93;
   }
   vec2 G=mix(uvC,sUV,globe*step(rr2,1.));
   float S=max(R/3.2,30.);
   vec2 Pp=G*S+vec2(0.,t*1.1*(1.-globe));
   vec2 blk=floor(Pp*0.5)*2.+1.;
   vec2 fb=Pp-blk;
   float liDot=clamp(liSoft*0.55,0.,1.);
   float dHalf=length(fb)-mix(0.10,0.78,pow(liDot,1.15));
   vec2 gcell=floor(vec2(Pp.x/4.,Pp.y/6.));
   vec2 inG=Pp-gcell*vec2(4.,6.);
   vec2 px=floor(inG);
   float h=hash(gcell+3.1);
   float cap=step(1.-prog*0.8,h);
   float dg=mix(floor(hash(gcell+floor(t*(0.35+1.3*h))*0.731)*16.),floor(h*16.),cap);
   float on=glyphOn(dg,px);
   vec2 fp=inG-px-0.5;
   float dSq=max(abs(fp.x),abs(fp.y))-0.40;
   float nA=fbm(G*1.1+vec2(t*0.035,-t*0.028));
   float nB=fbm(G*2.3-vec2(t*0.02,t*0.03)+7.);
   float fM=(nA*0.75+nB*0.25-0.48)*2.4+(mixv-0.5)*1.9;
   float age=bloom.z;
   float brad=0.05+0.22*sqrt(max(age,0.));
   float bl=smoothstep(brad+0.07,brad-0.07,length(uv-bloom.xy)+0.12*(nB-0.5))*exp(-max(age-1.4,0.)*0.9)*step(0.,age);
   fM+=bl*0.9;
   float kM=max(smoothstep(-0.17,0.17,fM),globe);
   float aa=S*pxu*0.9;
   float dM=mix(dHalf,dSq,kM);
   float cov=on>0.5?smoothstep(aa,-aa,dM):smoothstep(aa,-aa,dHalf)*(1.-kM);
   float rim=on*smoothstep(aa*2.5,0.,abs(dM))*(1.-abs(kM*2.-1.))*0.6;
   float bH=0.16+liDot*0.6;
   float bC=0.09+liSoft*0.5+cap*0.62+bl*0.55;
   vec3 tint=hue(hueField(G,t,think));
   vec3 cc=mix(mix(vec3(1.),tint,0.5)*bH,mix(vec3(1.),tint,0.25+0.45*cap)*bC,kM);
   vec3 dataC=cc*cov+tint*rim*0.5;
   float gl2=smoothstep(0.5,1.,globe);
   if(gl2>0.001){
    vec2 gc4=vec2(Pp.x/4.,Pp.y/6.);
    vec2 ae=abs(fract(gc4)-0.5);
    float lw=0.035;
    float lines=max(smoothstep(0.5-lw,0.5,ae.x),smoothstep(0.5-lw*0.66,0.5,ae.y));
    vec2 c4=(fract(gc4)-0.5)*vec2(4.,6.);
    float node=smoothstep(1.15,0.55,length(c4))*cap;
    vec3 latt=mix(vec3(1.),tint,0.55)*lines*0.20+mix(vec3(1.),tint,0.6)*node*1.15;
    dataC=mix(dataC,latt,gl2);
   }
   gcol=dataC*fade*mix(1.,0.3+0.7*zS,globe)*dots;
   ck=mix(1.,mix(0.,0.30,kM)*(1.-globe),smoothstep(0.,0.4,dots));
   hk=mix(1.,0.45*(1.-0.6*globe),dots);
  }else if(type<1.5){
   float N=21.;
   vec2 gg=uvC*N;vec2 cell=floor(gg)+0.5;vec2 f=gg-cell;
   float h=hash(cell*1.31+7.);
   float cap=step(1.-prog*0.7,h);
   float li=clamp(liSoft*0.6,0.,1.);
   float rD=mix(0.06,0.42,li)+cap*0.08;
   float aa=pxu*N*0.9;
   float dm=smoothstep(rD+aa,rD-aa,length(f));
   float bb=0.30+li*0.8+cap*(0.35+0.2*sin(t*1.3+h*6.28));
   gcol=mix(vec3(1.),hue(hueField(uvC,t,think)),0.35+0.4*cap)*dm*bb*fade;
   ck=0.;hk=0.75;
  }else if(type<2.5){
   float N=8.5;
   vec2 gg=uvC*vec2(N*1.5,N)+vec2(0.,t*0.12*(1.-prog));
   vec2 cell=floor(gg);vec2 f=fract(gg);
   vec2 px=floor(vec2(f.x*4.,f.y*6.));
   float h=hash(cell+3.1);
   float cap=step(1.-prog*0.8,h);
   float dg=mix(floor(hash(cell+floor(t*(0.5+2.*h))*0.731)*16.),floor(h*16.),cap);
   float on=glyphOn(dg,px);
   vec2 pf=fract(vec2(f.x*4.,f.y*6.));
   float sq=step(0.1,pf.x)*step(pf.x,0.9)*step(0.1,pf.y)*step(pf.y,0.9);
   float bb=0.035+pow(min(lightI,2.),1.4)*0.5+cap*0.5;
   gcol=mix(vec3(1.),hue(hueField(uvC,t,think)),0.25+0.5*cap)*on*sq*bb*fade;
   ck=0.35;hk=0.6;
  }else if(type<3.5){
   float rr=sqrt(r2)/0.93;
   if(rr<1.){
    float z=sqrt(1.-rr*rr);
    vec3 P=vec3(uv/0.93,z);
    float ay=t*0.12;float ca=cos(ay),sa=sin(ay);
    P=vec3(ca*P.x+sa*P.z,P.y,-sa*P.x+ca*P.z);
    float cb=cos(0.42),sb=sin(0.42);
    P=vec3(P.x,cb*P.y-sb*P.z,sb*P.y+cb*P.z);
    float lat=asin(clamp(P.y,-1.,1.));
    float lon=atan(P.z,P.x);
    float nLat=9.,nLon=18.;
    float uLat=lat/3.14159*nLat,uLon=lon/6.28318*nLon;
    float aLat=abs(fract(uLat)-0.5),aLon=abs(fract(uLon)-0.5);
    float th=0.022+0.012*(1.-z);
    float lineLat=smoothstep(0.5-th,0.5,aLat);
    float lineLon=smoothstep(0.5-th*1.3,0.5,aLon)*smoothstep(0.,0.3,cos(lat));
    float glin=max(lineLat,lineLon);
    vec2 cid=vec2(floor(uLat+0.5),floor(uLon+0.5));
    float h=hash(cid+11.);
    float cap=step(1.-prog*0.72,h);
    float dn=length(vec2(0.5-aLat,(0.5-aLon)*cos(lat)));
    float node=smoothstep(0.17,0.06,dn)*cap;
    vec3 tint=hue(hueField(uv,t,think));
    gcol=(mix(vec3(1.),tint,0.55)*glin*0.24+mix(vec3(1.),tint,0.6)*node*(1.05+0.25*sin(t*1.6+h*6.28)))*(0.3+0.7*z)*fade;
   }
   ck=0.;hk=0.55;
  }else if(type>4.5){
   float rows=11.;
   float yy=uvC.y*rows+t*0.7*(1.-0.6*prog);
   float ri=floor(yy);float fy=fract(yy);
   float h1=hash(vec2(ri,2.7)),h2=hash(vec2(ri,5.1)),h3=hash(vec2(ri,8.3));
   float cap=step(1.-prog*0.85,hash(vec2(ri,11.9)));
   float xx=uvC.x;
   float lineY=smoothstep(0.15+pxu*rows,0.15-pxu*rows,abs(fy-0.5));
   float aa=pxu*1.5;
   float s1=smoothstep(-0.82-aa,-0.82+aa,xx)*smoothstep(-0.34+0.18*h1+aa,-0.34+0.18*h1-aa,xx);
   float s2=smoothstep(-0.22-aa,-0.22+aa,xx)*smoothstep(0.08+0.16*h2+aa,0.08+0.16*h2-aa,xx);
   float s3=smoothstep(0.42-0.14*h3-aa,0.42-0.14*h3+aa,xx)*smoothstep(0.74+aa,0.74-aa,xx);
   float dotV=smoothstep(0.2,0.12,length(vec2((xx-0.86)*rows,(fy-0.5))));
   float segs=max(max(s1,s2*0.8),s3);
   float bb=0.06+liSoft*0.45+cap*0.4;
   gcol=mix(vec3(1.),hue(hueField(uvC,t,think)),0.25+0.5*cap)*(segs*lineY*bb+dotV*cap*1.1)*fade;
   ck=0.15;hk=0.7;
  }else{
   float N=31.;
   float xx=(uvC.x*0.5+0.5)*N;
   float bi=floor(xx);float fx=fract(xx);
   float xc=(bi+0.5)/N*2.-1.;
   float h=hash(vec2(bi,4.2));
   float env=exp(-xc*xc*2.2);
   float cap=step(1.-prog*0.8,h);
   float amp=(0.05+0.40*energy*(0.55+0.45*sin(t*(1.2+h*1.2)+h*6.28)))*env;
   amp=max(amp,0.025+cap*0.22*env);
   float aa=pxu*N*0.6;
   float inX=smoothstep(0.32+aa,0.32-aa,abs(fx-0.5));
   float yy=abs(uvC.y-0.03);
   float inY=smoothstep(amp+pxu*1.5,amp-pxu*1.5,yy);
   float tip=smoothstep(amp*0.55,amp,yy);
   float bb=0.2+liSoft*0.55+0.45*env+0.25*cap;
   gcol=mix(hue(clamp(0.5+0.6*xc,0.,1.)),vec3(1.),tip*0.45)*inX*inY*bb*fade;
   ck=0.15;hk=0.7;
  }
  coreK=mix(1.,ck,hasGrid);haloK=mix(1.,hk,hasGrid);gcol*=hasGrid;
 }
 vec3 light=vec3(1.)*core*0.80*coreK+mix(vec3(1.),hc,0.74)*gS*0.44*haloK+hc*gL*mix(0.36,0.22,think)*haloK;
 light+=(nebC*0.26+mix(vec3(1.),hc,0.55)*cg*0.30)*think*haloK;
 if(type>5.5)light+=mix(vec3(1.),hc,0.5)*exp(-dot(uvL,uvL)/0.12)*0.20*dots*(1.-globe)*hasGrid;
 light=light*(1.-0.45*hasGrid)+gcol;
 return light;
}
void main(){
 vec2 fc=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uDpr;
 float t=uTime;
 float dN=1e4;vec2 nC=uC;float nR=max(uR,1.);float nType=uMainGrid;float nThink=uThink;float nEnergy=uEnergy;float nProg=uProg;float nDots=uDots;float nMix=uMix;vec3 nBloom=uBloom;float nGlobe=uGlobe;float nGrid=1.;float nT=t;float isMain=1.;float nFlash=0.;
 if(uR>0.5){dN=blobMain(fc-uC,uR,t);}
 for(int i=0;i<7;i++){
  if(float(i)<uN){
   vec4 b=uB[i];
   if(b.z>0.5){
    float di=blobField(fc-b.xy,b.z,t+uQ[i].x,uP[i].z,uP[i].w);
    if(di<dN){dN=di;nC=b.xy;nR=b.z;nType=b.w;nThink=uP[i].x;nEnergy=uP[i].y;nProg=0.78;nDots=1.;nMix=uQ[i].z;nBloom=vec3(0.,0.,99.);nGlobe=0.;nGrid=uQ[i].w;nT=t+uQ[i].x;isMain=0.;nFlash=uQ[i].y;}
   }
  }
 }
 float d=sceneD(fc,t);
 float dither=(hash(fc*1.37+fract(t))-0.5)/255.;
 float shKeep=1.;
 if(uR>0.5){float r0=min(uR,170.);float ds0=blobMain(fc-uC-vec2(0.,0.17*r0),uR,t)+0.05*r0;shKeep*=1.-(0.21*exp(-max(ds0,0.)/(0.15*r0))+0.05*exp(-max(ds0,0.)/(0.4*r0)))*smoothstep(4.,40.,uR)*(1.-smoothstep(0.8*r0,1.2*r0,max(ds0,0.)));}
 for(int i=0;i<7;i++){
  if(float(i)<uN){
   vec4 b=uB[i];
   if(b.z>0.5){float ri=min(b.z,170.);float dsi=blobField(fc-b.xy-vec2(0.,0.17*ri),b.z,t+uQ[i].x,uP[i].z,uP[i].w)+0.05*ri;
    shKeep*=1.-(0.21*exp(-max(dsi,0.)/(0.15*ri))+0.05*exp(-max(dsi,0.)/(0.4*ri)))*(1.-uQ[i].y)*(1.-smoothstep(0.8*ri,1.2*ri,max(dsi,0.)));}
  }
 }
 float sh=max(1.-shKeep,0.);
 sh=max(sh+dither*smoothstep(0.,0.002,sh),0.);
 float shR=clamp(nR,40.,170.);
 if(d>3.2*shR&&sh<0.002){gl_FragColor=vec4(0.);return;}
 if(d>1.5){gl_FragColor=vec4(0.,0.,0.,sh*uFade);return;}
 float a=clamp(0.5-d*uDpr,0.,1.);
 float e=1.0;
 vec2 g=vec2(sceneD(fc+vec2(e,0.),t)-sceneD(fc-vec2(e,0.),t),sceneD(fc+vec2(0.,e),t)-sceneD(fc-vec2(0.,e),t));
 g=g/max(length(g),1e-5);
 float inside=max(-d,0.);
 float bevel=min(nR*0.45,120.);
 float x=clamp(inside/max(bevel,1.),0.,1.);
 float slope=pow(1.-x,2.);
 vec3 n=normalize(vec3(g*slope*2.4,1.));
 vec3 L=normalize(vec3(-0.45,-0.85,0.65));
 float fres=pow(clamp(1.-n.z,0.,1.),1.6);
 vec3 rf=reflect(vec3(0.,0.,-1.),n);
 float spec=pow(max(dot(rf,L),0.),70.);
 vec2 uv=(fc-nC)/nR;
 float yl=clamp(0.5+0.5*uv.y,0.,1.);
 vec3 body=mix(vec3(0.016),vec3(0.05),smoothstep(0.15,1.,yl));
 float bottomness=smoothstep(-0.3,1.,g.y);
 vec3 col=mix(body,vec3(0.6),fres*(0.26+0.5*bottomness));
 vec3 light=orbLight(fc,nC,nR,nT,nType,nThink,nEnergy,nProg,nDots,nMix,nBloom,nGlobe,nGrid);
 light*=1.+nFlash*14.;
 light*=(1.+0.25*uPulse*isMain);
 light*=smoothstep(0.,0.3*min(nR,170.),inside);
 float rimZone=exp(-inside/(0.07*min(nR,170.)+1.))*bottomness;
 light+=hue(0.5+0.4*clamp(uv.x,-1.,1.))*rimZone*(0.12+0.35*nEnergy+0.25*nThink);
 float lum=max(light.r,max(light.g,light.b));
 light=mix(light,vec3(lum),smoothstep(1.1,2.6,lum)*0.45);
 light=1.-exp(-light*1.1);
 float line=exp(-inside*inside/1.1);
 vec2 ld=normalize(vec2(-0.45,-0.89));
 float facing=max(dot(g,ld),0.);
 col+=vec3(1.)*line*(0.16+0.6*facing+0.32*max(g.y,0.));
 col+=vec3(1.)*spec*0.85;
 float sheen=smoothstep(0.,1.,-g.y)*exp(-inside/(0.16*min(nR,170.)+1.))*0.09;
 col+=vec3(sheen)+light+dither;
 col=mix(col,vec3(0.985),smoothstep(0.35,1.,nFlash));
 gl_FragColor=vec4(col*a,a+sh*(1.-a)*(1.-nFlash))*uFade;
}`;
