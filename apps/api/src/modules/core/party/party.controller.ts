// Party Controller — REST endpoints (secondary interface for party operations).
//
// The MCP tool layer is the PRIMARY interface. REST is provided as a
// secondary convenience for direct API consumers (admin UIs, integrations).
//
// Auth: Requires JWT with tenantId claim. The TenantGuard extracts the
// tenant context and attaches it to the request. No x-tenant-id header needed.
//
// Validation: All request bodies are validated by class-validator DTOs via
// the global ValidationPipe (configured in main.ts).
//
// VALIDATION STRATEGY (defense-in-depth across layers):
// - REST endpoints: class-validator DTOs in party.dto.ts (ValidationPipe)
// - MCP tools: Zod schemas in party-tools.ts with superRefine for cross-field
// - Service layer: Explicit validation in party.service.ts
// - Database: Constraints (unique indexes, FK, CHECK) as final safety net

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Res,
  ParseUUIDPipe,
  UnauthorizedException,
  HttpCode,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { TenantContext } from "../../../common/tenant-context.js";
import { PartyService } from "./party.service.js";
import {
  CreatePartyDto,
  SearchPartiesDto,
  AddPartyRoleDto,
  AddContactMechanismDto,
} from "./party.dto.js";

@Controller("parties")
export class PartyController {
  constructor(private readonly partyService: PartyService) {}

  private getTenantContext(req: Request): TenantContext {
    const ctx = req.tenantContext;
    if (!ctx?.tenantId) {
      // This should never happen if TenantGuard is properly registered.
      // Throwing UnauthorizedException returns a 401 instead of a 500.
      throw new UnauthorizedException(
        "Tenant context not found on request. Ensure TenantGuard is registered."
      );
    }
    return ctx;
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() req: Request,
    @Body() body: CreatePartyDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    // tenantId is placed AFTER spread to guarantee JWT context wins.
    // ValidationPipe (whitelist + forbidNonWhitelisted) would reject a
    // body containing a `tenantId` field with a 400 error since
    // CreatePartyDto doesn't declare it. The spread-after pattern is
    // the definitive safety net.
    return this.partyService.createParty({ ...body, tenantId });
  }

  @Get()
  async search(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: SearchPartiesDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    const { name, partyType, roleType, limit, offset } = query;
    const result = await this.partyService.searchParties({
      tenantId,
      name,
      partyType,
      roleType,
      limit,
      offset,
    });
    // Set pagination headers for API discoverability.
    // Clients can use these to build pagination UIs without parsing the body.
    res.setHeader("X-Total-Count", String(result.total));
    res.setHeader("X-Page-Limit", String(result.limit));
    res.setHeader("X-Page-Offset", String(result.offset));
    if (result.hasMore) {
      res.setHeader("X-Next-Offset", String(result.offset + result.limit));
    }
    return result;
  }

  @Get(":id")
  async get(
    @Req() req: Request,
    @Param("id", ParseUUIDPipe) partyId: string
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.getParty(tenantId, partyId);
  }

  @Post(":id/roles")
  @HttpCode(201)
  async addRole(
    @Req() req: Request,
    @Param("id", ParseUUIDPipe) partyId: string,
    @Body() body: AddPartyRoleDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.addPartyRole({
      ...body,
      tenantId,
      partyId,
    });
  }

  @Post(":id/contacts")
  @HttpCode(201)
  async addContact(
    @Req() req: Request,
    @Param("id", ParseUUIDPipe) partyId: string,
    @Body() body: AddContactMechanismDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.addContactMechanism({
      ...body,
      tenantId,
      partyId,
    });
  }
}
