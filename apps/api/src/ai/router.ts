import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { AiError, type AiProposalService } from "./service.js";
import type { AiRouterAuth } from "./contracts.js";
/** Mount at /api/projects/:projectId/ai/proposals with session authentication. */
export function createAiRouter(service: AiProposalService, auth: AiRouterAuth) {
  const router = Router({ mergeParams: true });
  const action =
    (
      handler: (
        actorId: string,
        projectId: string,
        request: Request,
      ) => Promise<unknown>,
      mutate = false,
    ) =>
    async (request: Request, response: Response, next: NextFunction) => {
      try {
        if (mutate && request.headers.origin !== auth.trustedOrigin)
          throw new AiError(403, "Untrusted origin");
        const actorId = await auth.authenticate(request);
        if (!actorId) throw new AiError(401, "Sign in to use AI proposals");
        const projectId = request.params.projectId;
        if (typeof projectId !== "string")
          throw new AiError(400, "Invalid project");
        response.json(await handler(actorId, projectId, request));
      } catch (error) {
        if (error instanceof AiError)
          response.status(error.status).json({ error: error.message });
        else next(error);
      }
    };
  const id = (request: Request) => {
    if (typeof request.params.id !== "string")
      throw new AiError(400, "Invalid proposal");
    return request.params.id;
  };
  router.post(
    "/",
    action(
      (actor, project, req) => service.create(actor, project, req.body),
      true,
    ),
  );
  router.get(
    "/:id",
    action((actor, project, req) => service.get(actor, project, id(req))),
  );
  router.post(
    "/:id/accept",
    action(
      (actor, project, req) => service.accept(actor, project, id(req)),
      true,
    ),
  );
  router.post(
    "/:id/reject",
    action(
      (actor, project, req) => service.reject(actor, project, id(req)),
      true,
    ),
  );
  return router;
}
