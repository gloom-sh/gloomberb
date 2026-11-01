import { getDataDir } from "../data/config/store";
import { getGloomberbDirs } from "../data/config/home";

/** The data folder this profile uses, whether or not anything has created it yet. Never writes. */
export async function resolveCliDataDir(): Promise<string> {
  return await getDataDir() ?? getGloomberbDirs().data;
}
