// @Public() decorator — Marks endpoints as public (no JWT required).
//
// Usage:
//   @Public()
//   @Get('health')
//   health() { ... }

import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = Symbol("isPublic");
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
