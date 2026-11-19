# base44-vercel-adapter

Publica en **Vercel** una app hecha en **Base44** (plantilla TanStack Start) sin que dependa de Base44 en producción:

| En Base44 | Con el adaptador |
| --- | --- |
| Base de datos de entidades | PostgreSQL (Neon), tabla `b44_entities` (se crea sola) |
| `integrations.Core.SendEmail` y plantillas de `base44/emails` | Resend |
| Imágenes subidas a Base44 | Se descargan en cada build a `public/media/` y se sirven desde tu dominio |
| Scripts del editor y analytics de Base44 | Se quitan |
| `base44:runtime` → `secrets.get("X")` | Variables de entorno de Vercel |
| Hosting en Cloudflare Workers | Vercel Functions (Nitro) |

Tú sigues editando en Base44. Base44 sincroniza el código con GitHub, y Vercel lo compila con este adaptador.

## Configurar un proyecto en Vercel (una vez por cliente)

1. En Base44: conecta la app a un repo de GitHub (ícono **> _** → GitHub).
2. En Vercel: **Add New → Project** → importa ese repo. Framework: **TanStack Start**.
3. **Settings → Build and Deployment → Install Command** (activa el override):
   ```
   rm -rf .b44adapter && git clone --depth 1 --branch v1 https://github.com/emarigo93/base44-vercel-adapter .b44adapter && node .b44adapter/apply.mjs && npm install
   ```
   Build Command y Output Directory: sin override.
4. **Storage → Create Database → Neon** y conéctala al proyecto (`DATABASE_URL`).
5. **Settings → Environment Variables**:

   | Variable | Ejemplo | Para qué |
   | --- | --- | --- |
   | `RESEND_API_KEY` | `re_...` | Enviar correos |
   | `EMAIL_FROM` | `Canabal Accounting <notificaciones@ronpontech.com>` | Remitente (dominio verificado en Resend). Si la app manda `from_name`, se usa ese nombre con esta dirección. |
   | `SITE_URL` | `https://canabalcpa.ronpontech.com` | Dominio público: lo usan las imágenes de los correos y los enlaces que apuntaban a `*.base44.app`. Si no está, se usa el dominio de producción de Vercel. |
   | Secretos de la app | el mismo nombre que en Base44 | Lo que el código lee con `secrets.get("NOMBRE")` |

6. **Deploy**. Después de eso, cada cambio en Base44 se publica solo.

## Qué no está soportado (todavía)

Si la app usa algo de esta lista, esa llamada da un error claro ("no está disponible en esta instalación") en vez de llamar a Base44 sin que te enteres. Un módulo `base44:*` desconocido hace fallar el build:

- Inicio de sesión de usuarios de Base44 (`auth.*`): todos los visitantes son anónimos. Los paneles protegidos con un código propio (como `/admin` de Canabal) sí funcionan.
- Acceso a entidades desde el navegador: en la plantilla TanStack Start los datos pasan por funciones del servidor, que sí funcionan.
- `UploadFile`, `InvokeLLM`, `aiGateway`, agentes, conectores, pagos y `functions.invoke`.
- Tiempo real (`subscribe` no avisa de cambios).

## Mantenimiento

- Versión estable: la etiqueta `v1`. Los cambios grandes salen como `v2`, así ningún sitio se rompe por sorpresa.
- Si Base44 cambia su plantilla y el build falla, Vercel mantiene publicada la última versión buena. Se ajusta el adaptador y se vuelve a desplegar.

## Pasar datos de un proyecto anterior

Las entidades viven en `b44_entities (entity, id, data jsonb, created_date, updated_date, created_by, created_by_id)`.
Para copiar una tabla existente:

```sql
INSERT INTO b44_entities (entity, id, data, created_date, updated_date)
SELECT 'ServiceRequest', id, to_jsonb(t) - 'id' - 'created_date' - 'updated_date', created_date, updated_date
FROM service_requests t
ON CONFLICT DO NOTHING;
```
