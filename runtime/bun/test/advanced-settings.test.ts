import { expect, test } from "bun:test";
import { parseAdvancedSettings } from "../src/config-file";
import { parsePresetCatalog, loadPresetCatalog, tryLoadCatalogForDisplay } from "../src/launcher/catalog-listing";
import { LauncherError } from "../src/config-error";
import { Notices } from "../src/launcher/catalog-notices";

test("advanced settings have safe defaults and validate each named numeric knob", () => {
  expect(parseAdvancedSettings({}, "config.toml")).toEqual({
    roster_cache_ttl_seconds: 5, reporting_cache_ttl_seconds: 5, debug_tmux_sample_seconds: 5, debug_tmux_inventory_seconds: 60,
    debug_tmux_timeout_seconds: 3, debug_tmux_incident_gap_seconds: 600,
  });
  expect(parseAdvancedSettings({advanced:{roster_cache_ttl_seconds:0}}, "config.toml").roster_cache_ttl_seconds).toBe(0);
  for (const advanced of [[], "bad", {typo:5}, {roster_cache_ttl_seconds:-1}, {roster_cache_ttl_seconds:"5"}, {roster_cache_ttl_seconds:Infinity},
    {reporting_cache_ttl_seconds:-1}, {reporting_cache_ttl_seconds:"5"}, {reporting_cache_ttl_seconds:Infinity}]) {
    try { parseAdvancedSettings({advanced}, "config.toml"); throw new Error("expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(LauncherError); expect((error as LauncherError).errorClass).toBe("advanced_config_invalid"); expect((error as Error).message).toContain("advanced"); }
  }
});

test("tmux tuning accepts boundary values and refuses invalid cadence or bounds", () => {
  const read = (advanced: Record<string, unknown>) => parseAdvancedSettings({ advanced }, "config.toml");
  expect(read({ debug_tmux_sample_seconds: 1, debug_tmux_inventory_seconds: 1,
    debug_tmux_timeout_seconds: .1, debug_tmux_incident_gap_seconds: 0 })).toMatchObject({
    debug_tmux_sample_seconds: 1, debug_tmux_inventory_seconds: 1,
    debug_tmux_timeout_seconds: .1, debug_tmux_incident_gap_seconds: 0,
  });
  expect(read({ debug_tmux_sample_seconds: 3600, debug_tmux_inventory_seconds: 86400,
    debug_tmux_timeout_seconds: 30, debug_tmux_incident_gap_seconds: 86400 }).debug_tmux_sample_seconds).toBe(3600);
  for (const advanced of [
    { debug_tmux_sample_seconds: 0 }, { debug_tmux_sample_seconds: 3601 }, { debug_tmux_sample_seconds: 1.5 },
    { debug_tmux_inventory_seconds: 0 }, { debug_tmux_inventory_seconds: 86401 }, { debug_tmux_inventory_seconds: 60.5 },
    { debug_tmux_sample_seconds: 10, debug_tmux_inventory_seconds: 9 },
    { debug_tmux_timeout_seconds: 0 }, { debug_tmux_timeout_seconds: 30.1 }, { debug_tmux_timeout_seconds: NaN },
    { debug_tmux_incident_gap_seconds: -1 }, { debug_tmux_incident_gap_seconds: 86401 }, { debug_tmux_incident_gap_seconds: .5 },
  ]) expect(() => read(advanced)).toThrow("advanced_config_invalid");
});

test("the existing catalog read carries advanced settings even without presets", () => {
  let reads = 0;
  const source = Buffer.from("version = 2\n[advanced]\nroster_cache_ttl_seconds = 9\n");
  const read = (path: string) => {
    reads++;
    if (path.endsWith("presets.toml")) throw new LauncherError("absent","preset_config_missing");
    return {bytes:source,resolvedPath:path,digest:"hash"};
  };
  expect(loadPresetCatalog({},()=>{},read,"/config",()=>false).advanced).toMatchObject({roster_cache_ttl_seconds:9,debug_tmux_sample_seconds:5});
  expect(reads).toBe(2); // config and the existing legacy-presets fallback, no second config read
  expect(parsePresetCatalog(source,"/config/config.toml","hash",()=>{}).advanced).toMatchObject({roster_cache_ttl_seconds:9,debug_tmux_timeout_seconds:3});
  expect(() => tryLoadCatalogForDisplay(new Notices(()=>{}), {}, () => ({bytes:Buffer.from("version=2\n[advanced]\ntypo=1"), resolvedPath:"/config/config.toml",digest:"hash"}), "/config",()=>false)).toThrow("typo");
});
