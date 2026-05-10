// Party Controller — REST endpoints (secondary interface for party operations).
//
// The MCP tool layer is the PRIMARY interface. REST is provided as a
// secondary convenience for direct API consumers (admin UIs, integrations).
//
// Auth: Requires JWT with tenantId claim. The TenantGuard extracts the
// tenant context and attaches it to the request. No x-tenant-id header needed.

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { JwtValidatedUser } from "../../../auth/jwt.strategy";
import { PartyService } from "./party.service";
import {
  CreatePartyInput,
  SearchPartiesInput,
  AddPartyRoleInput,
  AddContactMechanismInput,
} from "./party.types";

@Controller("parties")
export class PartyController {
  constructor(private readonly partyService: PartyService) {}

  /**
   * Extract tenant context from the authenticated user on the request.
   */
  private getTenantUser(req: Request): { tenantId: string; userId: string } {
    const user = req.user as JwtValidatedUser;
    return { tenantId: user.tenantId, userId: user.userId };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() body: Omit<CreatePartyInput, "tenantId">
  ) {
    const { tenantId } = this.getTenantUser(req);
    return this.partyService.createParty({ ...body, tenantId });
  }

  @Get()
  async search(
    @Req() req: Request,
    @Query("name") name?: string,
    @Query("partyType") partyType?: string,
    @Query("roleType") roleType?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const { tenantId } = this.getTenantUser(req);
    return this.partyService.searchParties({
      tenantId,
      name,
      partyType,
      roleType,
      limit: limit ? Math.max(1, parseInt(limit, 10) || 50) : 50,
      offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0,
    });
  }

  @Get(":id")
  async get(
    @Req() req: Request,
    @Param("id") partyId: string
  ) {
    const { tenantId } = this.getTenantUser(req);
    return this.partyService.getParty(tenantId, partyId);
  }

  @Post(":id/roles")
  async addRole(
    @Req() req: Request,
    @Param("id") partyId: string,
    @Body() body: Omit<AddPartyRoleInput, "tenantId" | "partyId">
  ) {
    const { tenantId } = this.getTenantUser(req);
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
    @Body() body: Omit<AddContactMechanismInput, "tenantId" | "partyId">
  ) {
    const { tenantId } = this.getTenantUser(req);
    return this.partyService.addContactMechanism({
      ...body,
      tenantId,
      partyId,
    });
  }
}
