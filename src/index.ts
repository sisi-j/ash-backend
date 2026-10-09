import { handle } from "./app";
import { realDeps } from "./deps";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, realDeps());
  },
} satisfies ExportedHandler<Env>;
