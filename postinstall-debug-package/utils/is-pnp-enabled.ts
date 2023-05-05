// see https://yarnpkg.com/advanced/pnpapi#processversionspnp
export const isPnPEnabled: boolean = process.versions['pnp'] !== undefined;
