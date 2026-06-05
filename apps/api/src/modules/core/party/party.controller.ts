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

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { Request } from "express";
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

  /** Validate that a route param looks like a UUID. */
  private requireUuid(value: string, paramName: string): void {
    // Loosely match UUID format (8-4-4-4-12 hex chars with optional dashes).
    // Prisma will reject invalid UUIDs, but this gives a clear 400 error
    // instead of an opaque Prisma P2023 error.
    if (!/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(value)) {
      throw new BadRequestException(
        `Invalid '${paramName}': must be a valid UUID.`
      );
    }
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() body: CreatePartyDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    // tenantId is placed AFTER spread to guarantee JWT context wins,
    // though ValidationPipe (whitelist + forbidNonWhitelisted) would
    // strip a body-level tenantId anyway.
    return this.partyService.createParty({ ...body, tenantId });
  }

  @Get()
  async search(
    @Req() req: Request,
    @Query() query: SearchPartiesDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    const { name, partyType, roleType, limit = 50, offset = 0 } = query;
    return this.partyService.searchParties({
      tenantId,
      name,
      partyType,
      roleType,
      limit,
      offset,
    });
  }

  @Get(":id")
  async get(
    @Req() req: Request,
    @Param("id") partyId: string
  ) {
    const { tenantId } = this.getTenantContext(req);
    this.requireUuid(partyId, "id");
    return this.partyService.getParty(tenantId, partyId);
  }

  @Post(":id/roles")
  async addRole(
    @Req() req: Request,
    @Param("id") partyId: string,
    @Body() body: AddPartyRoleDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    this.requireUuid(partyId, "id");
    return this.partyService.addPartyRole({
      ...body,
      tenantId,
      partyId,
    });
  }

  @Post(":id/contacts")
  async addContact(
    @Req() req: Request,
    @Param("id") partyId: string,
    @Body() body: AddContactMechanismDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    this.requireUuid(partyId, "id");
    return this.partyService.addContactMechanism({
      ...body,
      tenantId,
      partyId,
    });
  }
}
