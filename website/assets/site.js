for (const block of document.querySelectorAll('.prose pre')) {
  const code = block.querySelector('code');
  if (!code || !navigator.clipboard) continue;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code to clipboard');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select to copy';
    }
    setTimeout(() => {button.textContent = 'Copy';}, 1800);
  });
  block.append(button);
}
// No scroll polling: one entrance per section and a finite diagram sequence.
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const activeMotion = new Set();
const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
function animateElement(element, frames, options = {}) {
  if (!element || motionPreference.matches || !element.animate) return;
  const animation = element.animate(frames, {duration:750,easing:ease,...options});
  activeMotion.add(animation);
  animation.finished.catch(() => {}).finally(() => activeMotion.delete(animation));
}
function showBranchDiagram() {
  if (motionPreference.matches) return;
  document.querySelectorAll('.branch-map *').forEach(el => el.getAnimations().forEach(a => a.cancel()));
  animateElement(document.querySelector('.map-source'),[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:500});
  animateElement(document.querySelector('.rail-active'),[{strokeDashoffset:1},{strokeDashoffset:0}],{duration:1400,delay:180,fill:'backwards'});
  document.querySelectorAll('.map-env').forEach((el,i) => {
    animateElement(el,[{opacity:0,transform:'translateX(-12px)'},{opacity:1,transform:'translateX(0)'}],{duration:800,delay:450+i*500,fill:'backwards'});
    animateElement(el.querySelector('.env-runtime'),[{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:550,delay:1050+i*550,fill:'backwards'});
  });
  animateElement(document.querySelector('.map-caption'),[{opacity:0},{opacity:1}],{duration:550,delay:1600,fill:'backwards'});
}
let revealObserver;
if (!motionPreference.matches && 'IntersectionObserver' in window) {
  document.querySelectorAll('.hero-line').forEach((el,i) => animateElement(el,[{opacity:0,transform:'translateY(25px)'},{opacity:1,transform:'translateY(0)'}],{delay:i*100,duration:850,fill:'backwards'}));
  showBranchDiagram();
  revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      animateElement(entry.target,[{opacity:0,transform:'translateY(20px)'},{opacity:1,transform:'translateY(0)'}],{duration:700});
      revealObserver.unobserve(entry.target);
    }
  }, {threshold:0.12});
  document.querySelectorAll('.section-label,.why-copy,.steps li,.reading-list>a,.closing').forEach(el=>revealObserver.observe(el));
}
document.querySelector('.replay-motion')?.addEventListener('click',showBranchDiagram);
motionPreference.addEventListener('change', () => {
  if (motionPreference.matches) { for(const a of activeMotion) a.cancel(); revealObserver?.disconnect(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for(const a of activeMotion) a.finish();
});
const diagram = document.querySelector('.workflow-diagram');
const diagramPlay = document.querySelector('.diagram-play');
const stepButtons = [...document.querySelectorAll('[data-step]')];
const phases = [
  ['$ runo new checkout-fix', "Your recipe defines the application and services. Runo provisions the branch's environment on AWS."],
  ['$ runo agent claude', 'Claude Code or Codex works on the remote VM, alongside the application and its configured services. You provide the agent credentials.'],
  ['$ runo url --open', 'Open the application in a browser, or share the preview URL. Previews do not add authentication to your app.'],
  ['$ runo validate', 'Run the checks in your recipe. Results and logs return to your worktree. Use runo pull to bring remote code changes back.']
];
let flowTimer;
let playingFlow = false;
function stopFlow() {
  clearTimeout(flowTimer);
  playingFlow = false;
  if (diagramPlay) {diagramPlay.textContent = '↻ Replay flow'; diagramPlay.setAttribute('aria-label','Replay the workflow animation');}
  diagram?.querySelectorAll('*').forEach(el=>el.getAnimations().forEach(a=>a.cancel()));
}
function selectPhase(index) {
  if (!diagram) return;
  diagram.dataset.phase = String(index);
  stepButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
  document.querySelector('.diagram-command').textContent = phases[index][0];
  document.querySelector('.diagram-explanation').textContent = phases[index][1];
  const targets=['.repo-node','.agent-node','.preview-node','.local-evidence'];
  animateElement(diagram.querySelector(targets[index]),[{transform:'translateY(5px)'},{transform:'translateY(0)'}],{duration:550});
  if(index===0||index===3) {
    const vertical=matchMedia('(max-width:640px)').matches;
    const packet=diagram.querySelector(index===0?'.outbound i':'.inbound i');
    animateElement(packet,[{opacity:0,transform:vertical?'translateY(-100%)':'translateX(-100%)'},{opacity:1,offset:.2},{opacity:1,offset:.8},{opacity:0,transform:vertical?'translateY(350%)':'translateX(350%)'}],{duration:1300,easing:'linear',iterations:2});
  }
}
function playFlow() {
  if (!diagram || motionPreference.matches) return;
  stopFlow();playingFlow=true;
  diagramPlay.textContent='Ⅱ Pause';diagramPlay.setAttribute('aria-label','Pause the workflow animation');
  let index=0;
  function next(){selectPhase(index++);if(index<phases.length)flowTimer=setTimeout(next,2700);else flowTimer=setTimeout(stopFlow,2700);}
  next();
}
stepButtons.forEach((button,index)=>button.addEventListener('click',()=>{stopFlow();selectPhase(index);}));
diagramPlay?.addEventListener('click',()=>{if(playingFlow)stopFlow();else playFlow();});
if(diagram && 'IntersectionObserver' in window) {
  let hasPlayed = false;
  const flowObserver=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting && !motionPreference.matches && !hasPlayed){hasPlayed=true;playFlow();}else if(!e.isIntersecting && playingFlow){stopFlow();}}},{threshold:.5});
  flowObserver.observe(diagram);
}
motionPreference.addEventListener('change',()=>{if(motionPreference.matches){stopFlow();if(diagramPlay)diagramPlay.hidden=true;}else if(diagramPlay)diagramPlay.hidden=false;});
if(motionPreference.matches && diagramPlay)diagramPlay.hidden=true;
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopFlow();});
