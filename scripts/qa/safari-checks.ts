import { SafariDriver, SafariError, pageUrl } from './safari-driver.ts';

export const allowedActions = ['Photography', 'Daylight photos', '3 hours', 'Any time'] as const;
export type Action = typeof allowedActions[number];
export function assertAction(value: string): asserts value is Action {
  if (!(allowedActions as readonly string[]).includes(value)) throw new SafariError('DISALLOWED_ACTION');
}
export type Observation = {
  innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; dpr: number;
  overflow: boolean; weatherHeading: boolean; branding: boolean; planner: boolean;
  control: boolean; selected: boolean; combination: boolean; recommendations: boolean; empty: boolean; alert: boolean;
};
// Fixed DOM observations and transient scrolling only: no storage, cookies, profile, page text dumps or page-provided code.
// Names/roles here are DOM accessibility attributes/native semantics, not a full AX-tree audit.
const domHelpers = `
const visible = e => {
 if (!e || !e.getClientRects().length) return false;
 for (let node = e; node; node = node.parentElement) {
  const style = getComputedStyle(node);
  if (node.getAttribute('aria-hidden')?.toLowerCase() === 'true' || node.hasAttribute('inert')
   || style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
 }
 return true;
};
const name = e => (e.getAttribute('aria-label') || e.textContent || '').trim();`;
export const observeScript = `
const [origin, label, expected] = arguments;
if (location.href !== origin + '/') return {redirect: true};
${domHelpers}
const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(visible);
const planner = headings.find(e => name(e) === 'Weather Intelligence V3')?.parentElement;
const buttons = planner ? [...planner.querySelectorAll('button,[role="button"]')].filter(visible) : [];
const controls = buttons.filter(e => name(e) === label);
const control = controls.length === 1 && !controls[0].disabled && controls[0].getAttribute('aria-disabled') !== 'true';
const selected = control && (controls[0].getAttribute('aria-pressed') === 'true' || controls[0].getAttribute('aria-selected') === 'true');
const required = !label ? [] : ['Photography', expected.includes('3 hours') ? '3 hours' : '1 hour', expected.endsWith('Any time') ? 'Any time' : 'Daylight photos'];
const combination = required.every(label => { const matches = buttons.filter(e => name(e) === label); return matches.length === 1 && (matches[0].getAttribute('aria-pressed') === 'true' || matches[0].getAttribute('aria-selected') === 'true'); });
const texts = planner ? [...planner.querySelectorAll('[aria-live="polite"]')].filter(visible) : [];
const recommendation = texts.find(e => /^([1-3]) recommendations for /.test(name(e)) && name(e).endsWith(expected));
const rank = planner ? [...planner.querySelectorAll('div')].find(e => visible(e) && name(e) === '#1 · Photography') : null;
const card = rank?.parentElement?.parentElement;
const score = card ? [...card.querySelectorAll('[aria-label]')].find(e => visible(e) && /^Weather conditions score (?:100(?:\\.0)?|[0-9]{1,2}(?:\\.[0-9])?) out of 100$/.test(name(e))) : null;
if (label && recommendation && card) card.scrollIntoView({block:'center'});
const inViewport = e => !!e && e.getBoundingClientRect().top >= 0 && e.getBoundingClientRect().bottom <= innerHeight;
// Ignore only descendants of the app's reviewed horizontal forecast scroller.
// Check the scroller's own bounds and every other visible node, even inside a
// vertical ScrollView whose overflow-x:hidden masks overflow at document level.
const hourly = '[aria-label="24-hour forecast. Scroll horizontally for later hours."]';
const clipped = style => ['hidden','clip','auto','scroll'].includes(style.overflowX);
const contentOverflow = [...document.querySelectorAll('*')].some(e => {
 if (!visible(e) || e.parentElement?.closest(hourly)) return false;
 const rect = e.getBoundingClientRect(), style = getComputedStyle(e);
 if (rect.left < -1 || rect.right > innerWidth + 1) return true;
 if (!e.matches(hourly) && clipped(style) && !['auto','scroll'].includes(style.overflowX) && e.scrollWidth > e.clientWidth + 1) return true;
 for (let parent = e.parentElement; parent; parent = parent.parentElement) {
  if (clipped(getComputedStyle(parent))) {
   const bounds = parent.getBoundingClientRect();
   if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) return true;
  }
 }
 return false;
});
return {innerWidth, innerHeight, outerWidth, outerHeight, dpr:devicePixelRatio,
 overflow: contentOverflow || Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
 weatherHeading:headings.some(e => name(e) === 'Weather'),
 branding:[...document.querySelectorAll('div')].some(e => visible(e) && e.children.length <= 1 && name(e) === 'weather.'),
 planner:!!planner, control:!!control, selected:!!selected, combination,
 recommendations:!!recommendation && !!score && visible(card) && inViewport(card) && inViewport(recommendation),
 empty:texts.some(e => /^No (verified daylight|complete suitable) window$/.test(name(e))),
 alert:[...document.querySelectorAll('[role="alert"]')].some(visible)};`;
export const clickScript = `
const [origin, label] = arguments;
if (location.href !== origin + '/') return {redirect:true};
if (!['Photography','Daylight photos','3 hours','Any time'].includes(label)) return false;
${domHelpers}
const heading = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].find(e => visible(e) && name(e) === 'Weather Intelligence V3');
const controls = heading ? [...heading.parentElement.querySelectorAll('button,[role="button"]')].filter(e => visible(e) && name(e) === label) : [];
if (controls.length !== 1 || controls[0].disabled || controls[0].getAttribute('aria-disabled') === 'true' || controls[0].closest('a,form')) return false;
controls[0].scrollIntoView({block:'center'});
controls[0].click(); return true;`;

export async function safeUrl(driver: SafariDriver, session: string, origin: string) {
  return pageUrl(await driver.command('GET', `/session/${session}/url`), origin);
}
export async function observe(driver: SafariDriver, session: string, origin: string, label = '', expected = ''): Promise<Observation> {
  await safeUrl(driver, session, origin);
  const value = await driver.command('POST', `/session/${session}/execute/sync`, { script: observeScript, args: [origin, label, expected] });
  if (value && typeof value === 'object' && 'redirect' in value) throw new SafariError('UNEXPECTED_REDIRECT');
  if (!value || typeof value !== 'object') throw new SafariError('INVALID_OBSERVATION');
  const observation = value as Observation;
  for (const key of ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'dpr'] as const) {
    if (!Number.isFinite(observation[key]) || observation[key] <= 0 || observation[key] > 32768) throw new SafariError('INVALID_OBSERVATION');
  }
  for (const key of ['overflow', 'weatherHeading', 'branding', 'planner', 'control', 'selected', 'combination', 'recommendations', 'empty', 'alert'] as const) {
    if (typeof observation[key] !== 'boolean') throw new SafariError('INVALID_OBSERVATION');
  }
  return observation;
}
export async function click(driver: SafariDriver, session: string, origin: string, action: string) {
  assertAction(action);
  await safeUrl(driver, session, origin);
  const result = await driver.command('POST', `/session/${session}/execute/sync`, { script: clickScript, args: [origin, action] });
  if (result && typeof result === 'object' && 'redirect' in result) throw new SafariError('UNEXPECTED_REDIRECT');
  if (result !== true) throw new SafariError('CONTROL_UNAVAILABLE');
}

export async function waitForObservation(driver: SafariDriver, session: string, origin: string, label = '', expected = '') {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await observe(driver, session, origin, label, expected);
    if (result.planner && (!label || result.control && result.selected && result.combination && (result.recommendations || result.empty))) return result;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new SafariError(label ? 'CONTROL_OR_FORECAST_TIMEOUT' : 'WEATHER_UI_UNAVAILABLE');
}
