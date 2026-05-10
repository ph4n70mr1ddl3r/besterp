-- CreateTable
CREATE TABLE "party_type" (
    "party_id" TEXT NOT NULL,
    "parent_type_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ai_prompt_hint" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_type_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "party" (
    "party_id" TEXT NOT NULL,
    "party_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "party_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "person" (
    "party_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "birth_date" TIMESTAMP(3),
    "gender" TEXT,

    CONSTRAINT "person_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "organization" (
    "party_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "tax_id" TEXT,
    "registration_date" TIMESTAMP(3),

    CONSTRAINT "organization_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "role_type" (
    "role_type_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ai_prompt_hint" TEXT,
    "parent_type_id" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_type_pkey" PRIMARY KEY ("role_type_id")
);

-- CreateTable
CREATE TABLE "party_role" (
    "party_role_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "role_type_id" TEXT NOT NULL,
    "from_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "thru_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_role_pkey" PRIMARY KEY ("party_role_id")
);

-- CreateTable
CREATE TABLE "contact_mechanism_type" (
    "contact_mechanism_type_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ai_prompt_hint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_mechanism_type_pkey" PRIMARY KEY ("contact_mechanism_type_id")
);

-- CreateTable
CREATE TABLE "contact_mechanism" (
    "contact_mechanism_id" TEXT NOT NULL,
    "contact_mechanism_type_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_mechanism_pkey" PRIMARY KEY ("contact_mechanism_id")
);

-- CreateTable
CREATE TABLE "party_contact_mechanism" (
    "party_contact_mechanism_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "contact_mechanism_id" TEXT NOT NULL,
    "from_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "thru_date" TIMESTAMP(3),

    CONSTRAINT "party_contact_mechanism_pkey" PRIMARY KEY ("party_contact_mechanism_id")
);

-- CreateTable
CREATE TABLE "postal_address" (
    "contact_mechanism_id" TEXT NOT NULL,
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT NOT NULL,
    "state_province" TEXT,
    "postal_code" TEXT,
    "country" TEXT NOT NULL,

    CONSTRAINT "postal_address_pkey" PRIMARY KEY ("contact_mechanism_id")
);

-- CreateTable
CREATE TABLE "telecom_number" (
    "contact_mechanism_id" TEXT NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT '+1',
    "area_code" TEXT NOT NULL,
    "line_number" TEXT NOT NULL,
    "extension" TEXT,

    CONSTRAINT "telecom_number_pkey" PRIMARY KEY ("contact_mechanism_id")
);

-- CreateTable
CREATE TABLE "email_address" (
    "contact_mechanism_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "email_address_pkey" PRIMARY KEY ("contact_mechanism_id")
);

-- CreateTable
CREATE TABLE "ai_action_log" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT,
    "conversation_id" TEXT,
    "user_id" TEXT,
    "tenant_id" TEXT,
    "tool_called" TEXT NOT NULL,
    "tool_input" JSONB NOT NULL,
    "tool_output" JSONB,
    "reasoning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "idempotency_key" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "conversation_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input_hash" TEXT NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("idempotency_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "party_type_name_key" ON "party_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "role_type_name_key" ON "role_type"("name");

-- CreateIndex
CREATE UNIQUE INDEX "contact_mechanism_type_name_key" ON "contact_mechanism_type"("name");

-- AddForeignKey
ALTER TABLE "party_type" ADD CONSTRAINT "party_type_parent_type_id_fkey" FOREIGN KEY ("parent_type_id") REFERENCES "party_type"("party_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party" ADD CONSTRAINT "party_party_type_id_fkey" FOREIGN KEY ("party_type_id") REFERENCES "party_type"("party_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("party_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("party_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_type" ADD CONSTRAINT "role_type_parent_type_id_fkey" FOREIGN KEY ("parent_type_id") REFERENCES "role_type"("role_type_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_role" ADD CONSTRAINT "party_role_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("party_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_role" ADD CONSTRAINT "party_role_role_type_id_fkey" FOREIGN KEY ("role_type_id") REFERENCES "role_type"("role_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_mechanism" ADD CONSTRAINT "contact_mechanism_contact_mechanism_type_id_fkey" FOREIGN KEY ("contact_mechanism_type_id") REFERENCES "contact_mechanism_type"("contact_mechanism_type_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_contact_mechanism" ADD CONSTRAINT "party_contact_mechanism_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "party"("party_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_contact_mechanism" ADD CONSTRAINT "party_contact_mechanism_contact_mechanism_id_fkey" FOREIGN KEY ("contact_mechanism_id") REFERENCES "contact_mechanism"("contact_mechanism_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "postal_address" ADD CONSTRAINT "postal_address_contact_mechanism_id_fkey" FOREIGN KEY ("contact_mechanism_id") REFERENCES "contact_mechanism"("contact_mechanism_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telecom_number" ADD CONSTRAINT "telecom_number_contact_mechanism_id_fkey" FOREIGN KEY ("contact_mechanism_id") REFERENCES "contact_mechanism"("contact_mechanism_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_address" ADD CONSTRAINT "email_address_contact_mechanism_id_fkey" FOREIGN KEY ("contact_mechanism_id") REFERENCES "contact_mechanism"("contact_mechanism_id") ON DELETE CASCADE ON UPDATE CASCADE;
