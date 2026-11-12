/** How a part id reads in a recipe's pipeline: its category (by name) and a short label. Shared by the demo and the live page. */
export const partCat = (id: string): string => {
  const n = id.split('@')[0];
  if (/scanner|positions|facts|access-keys|rpc|fresh/.test(n)) return 'source';
  if (/shield|risk|verified|check|allowlist/.test(n)) return 'guard';
  if (/swap|revoke|withdraw|claim|atomic|intents/.test(n)) return 'action';
  if (/report|summary|merge/.test(n)) return 'sink';
  return 'transform';
};
export const prettyPart = (id: string) => id.split('@')[0].split('.').slice(1).join(' ').replace(/-/g, ' ');
