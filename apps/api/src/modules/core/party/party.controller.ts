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
    return (req as any).tenantContext;
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() body: CreatePartyDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.createParty({ ...body, tenantId });
  }

  @Get()
  async search(
    @Req() req: Request,
    @Query() query: SearchPartiesDto
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.searchParties({
      tenantId,
      ...query,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  @Get(":id")
  async get(
    @Req() req: Request,
    @Param("id") partyId: string
  ) {
    const { tenantId } = this.getTenantContext(req);
    return this.partyService.getParty(tenantId, partyId);
  }

  @Post(":id/roles")
  async addRole(
    @Req() req: Request,
    @Param("id") partyId: string,
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
  async addContact(
    @Req() req: Request,
    @Param("id") partyId: string,
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
