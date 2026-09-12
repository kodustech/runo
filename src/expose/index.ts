import type { NormalizedRecipe } from "../recipe";
import { cloudflareExpose } from "./cloudflare";
import { httpsExpose } from "./https";
import { ipExpose } from "./ip";
import type { ExposeProvider } from "./types";

export type { ExposeContext, ExposeProvider, ExposeService } from "./types";

/**
 * Picks how this env publishes its services. `ip` stays the default so recipes
 * written before tunnels keep behaving exactly as they did; `runo init`
 * proposes `mode: tunnel` for new ones.
 */
export function getExpose(recipe: NormalizedRecipe): ExposeProvider {
  switch (recipe.expose.mode) {
    case "https":
      return httpsExpose;
    case "tunnel":
      return cloudflareExpose(recipe.expose);
    case "ip":
    default:
      return ipExpose;
  }
}
