# karpathy-maldonado

Bot de WhatsApp que escucha grupos, extrae información de eventos usando LLMs y los almacena en una base de datos.

## Stack Tecnológico

- **Runtime**: Node.js 20+
- **Lenguaje**: TypeScript con Effect.ts
- **WhatsApp**: Baileys (@whiskeysockets/baileys)
- **Base de datos**: TursoDB (LibSQL) con Drizzle ORM
- **LLM**: OpenRouter API
- **Despliegue**: fly.io

## Variables de Entorno

Crea un archivo `.env` basado en `.env.example`:

```bash
# Grupos de WhatsApp a monitorear (JIDs separados por coma)
WHATSAPP_ALLOWED_GROUPS=1234567890@g.us

# OpenRouter para extracción de eventos con LLM
OPENROUTER_API_KEY=tu_api_key_aqui
OPENROUTER_MODEL=openai/gpt-oss-120b

# Base de datos Turso
TURSO_DB_URL=libsql://tu-db.turso.io
TURSO_DB_AUTH_TOKEN=tu_token_aqui
```

> Deja `WHATSAPP_ALLOWED_GROUPS` vacío para correr en modo discovery - el app listará todos tus grupos y sus JIDs.

## Desarrollo Local

```bash
# Instalar dependencias
pnpm install

# Copiar y configurar variables de entorno
cp .env.example .env

# Correr en modo desarrollo
pnpm dev

# O producción
pnpm start
```

## Base de Datos

```bash
# Generar migraciones
pnpm run db:generate

# Aplicar migraciones
pnpm run db:push

# Abrir Drizzle Studio
pnpm run db:studio
```

## Despliegue en fly.io

### 1. Instalar flyctl

```bash
pnpm add -g flyctl
```

### 2. Crear cuenta en fly.io

```bash
flyctl auth login
```

### 3. Crear la aplicación

```bash
pnpm run fly:launch
```

### 4. Crear volumen persistente

El autenticación de WhatsApp requiere almacenamiento persistente:

```bash
flyctl volumes create auth_info --size 1 --app karpathy-maldonado-whatsapp
```

### 5. Configurar secretos

```bash
# OpenRouter
flyctl secrets set OPENROUTER_API_KEY=tu_key --app karpathy-maldonado-whatsapp

# TursoDB (crea una cuenta gratuita en https://turso.tech)
flyctl secrets set TURSO_DB_URL=libsql://tu-db.turso.io --app karpathy-maldonado-whatsapp
flyctl secrets set TURSO_DB_AUTH_TOKEN=tu_token --app karpathy-maldonado-whatsapp

# Grupos de WhatsApp (obtén los JIDs corriendo en modo discovery localmente)
flyctl secrets set WHATSAPP_ALLOWED_GROUPS=1234567890@g.us --app karpathy-maldonado-whatsapp
```

### 6. Desplegar

```bash
pnpm run fly:deploy
```

### 7. Vincular WhatsApp

El primer despliegue mostrará un código QR. Vincula tu WhatsApp escaneando el QR:

```bash
pnpm run fly:logs
```

### Comandos útiles

```bash
# Ver logs en tiempo real
pnpm run fly:logs

# Listar secretos
pnpm run fly:secrets

# Acceder a la máquina via SSH
pnpm run fly:ssh
```

## Arquitectura

```
src/
├── index.ts           # Punto de entrada
├── config.ts          # Configuración
├── connection.ts      # Conexión a WhatsApp con auto-reconnect
├── message-handler.ts # Procesamiento de mensajes
├── openrouter.ts      # Cliente OpenRouter para LLM
├── groups.ts          # Descubrimiento de grupos
└── db/
    ├── schema.ts      # Esquema Drizzle
    └── index.ts       # Cliente de base de datos
```
