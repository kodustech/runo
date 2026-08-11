// Lint minimalista: transpila cada .ts do projeto — erro de sintaxe reprova.
import { Glob } from "bun";

const transpiler = new Bun.Transpiler({ loader: "ts" });
let failed = false;

for await (const file of new Glob("{src,scripts}/**/*.ts").scan(".")) {
  try {
    transpiler.transformSync(await Bun.file(file).text());
    console.log(`lint ok: ${file}`);
  } catch (e) {
    failed = true;
    console.error(`lint FALHOU: ${file}: ${e}`);
  }
}

process.exit(failed ? 1 : 0);
