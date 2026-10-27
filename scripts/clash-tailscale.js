// Paste into Clash Verge Rev > Profiles > Global Extension Script.
// Preserves existing proxy groups, rules, DNS servers, and TUN state.
function main(config) {
  const union=(old,extra)=>Array.from(new Set([...(old||[]),...(extra||[])]));
  config.tun=config.tun||{};
  config.tun['route-exclude-address']=union(config.tun['route-exclude-address'],['100.64.0.0/10','fd7a:115c:a1e0::/48']);
  config.dns=config.dns||{};
  config.dns['fake-ip-filter']=union(config.dns['fake-ip-filter'],['+.ts.net']);
  config.dns['nameserver-policy']={...(config.dns['nameserver-policy']||{}),'+.ts.net':'100.100.100.100'};
  config.rules=union(['DOMAIN-SUFFIX,ts.net,DIRECT','IP-CIDR,100.64.0.0/10,DIRECT,no-resolve','IP-CIDR6,fd7a:115c:a1e0::/48,DIRECT,no-resolve'],config.rules);
  return config;
}
