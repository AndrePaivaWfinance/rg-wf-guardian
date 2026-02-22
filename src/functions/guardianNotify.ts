import { app, InvocationContext, Timer } from '@azure/functions';
import { getGuardianAuthorizations, getApprovedAuthorizations } from '../storage/tableClient';
import { getCadastroRecords } from '../storage/areaTableClient';
import { seedCategoriasIfEmpty } from './guardianCadastros';
import { createLogger, nowISO } from '../shared/utils';
import { Categoria } from '../shared/areas';

const logger = createLogger('GuardianNotify');

/**
 * GAP #10: Proactive Notifications
 *
 * Timer trigger that runs daily at 8:00 AM (America/Sao_Paulo).
 * Checks for:
 *   1. Pending transactions awaiting approval
 *   2. Over-budget categories (actual > orcamentoMensal)
 *   3. Critical audit alerts
 *
 * Sends notifications via:
 *   - Microsoft Teams webhook (if TEAMS_WEBHOOK_URL is configured)
 *   - Microsoft Graph API email (if GRAPH_* credentials are configured)
 */

interface NotificationPayload {
    title: string;
    items: Array<{ label: string; value: string; severity: 'info' | 'warning' | 'critical' }>;
    timestamp: string;
}

/** Build notification payload from current data state */
async function buildNotifications(): Promise<NotificationPayload | null> {
    const [pending, approved, categorias] = await Promise.all([
        getGuardianAuthorizations(),
        getApprovedAuthorizations(),
        seedCategoriasIfEmpty(),
    ]);

    const items: NotificationPayload['items'] = [];

    // 1. Pending transactions
    if (pending.length > 0) {
        const totalValor = pending.reduce((s, i) => s + i.valor, 0);
        items.push({
            label: `${pending.length} transacao(oes) pendente(s) de aprovacao`,
            value: `R$ ${totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
            severity: pending.length > 10 ? 'critical' : 'warning',
        });
    }

    // 2. Over-budget categories (current month)
    const now = new Date();
    const monthKey = now.toISOString().substring(0, 7); // YYYY-MM
    const monthItems = approved.filter(i => {
        const d = i.dataCompetencia || i.data || '';
        return d.startsWith(monthKey);
    });
    const catMap = new Map<string, Categoria>();
    for (const c of categorias) catMap.set(c.nome, c);

    const catTotals = new Map<string, number>();
    for (const item of monthItems) {
        const cat = catMap.get(item.classificacao);
        if (!cat) continue;
        catTotals.set(cat.nome, (catTotals.get(cat.nome) || 0) + item.valor);
    }

    for (const [nome, total] of catTotals) {
        const cat = catMap.get(nome);
        if (!cat || cat.orcamentoMensal <= 0) continue;
        const pct = (total / cat.orcamentoMensal) * 100;
        if (pct >= 100) {
            items.push({
                label: `"${nome}" estourou o orcamento`,
                value: `${pct.toFixed(0)}% (R$ ${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${cat.orcamentoMensal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })})`,
                severity: pct >= 150 ? 'critical' : 'warning',
            });
        }
    }

    // 3. Critical audit alerts
    const criticals = approved.filter(i => i.audit?.alert === 'critical');
    if (criticals.length > 0) {
        items.push({
            label: `${criticals.length} alerta(s) critico(s) de auditoria`,
            value: `Revisar itens com variacao orçamentária critica`,
            severity: 'critical',
        });
    }

    if (items.length === 0) return null;

    return {
        title: `Guardian — Resumo Diario (${now.toLocaleDateString('pt-BR')})`,
        items,
        timestamp: nowISO(),
    };
}

/** Send Teams notification via incoming webhook */
async function sendTeamsNotification(payload: NotificationPayload): Promise<boolean> {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
        logger.info('TEAMS_WEBHOOK_URL nao configurado — notificacao Teams ignorada.');
        return false;
    }

    const facts = payload.items.map(i => ({
        name: `${i.severity === 'critical' ? '🔴' : i.severity === 'warning' ? '🟡' : '🔵'} ${i.label}`,
        value: i.value,
    }));

    const card = {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        themeColor: payload.items.some(i => i.severity === 'critical') ? 'D93036' : 'CF8A12',
        summary: payload.title,
        sections: [{
            activityTitle: payload.title,
            activitySubtitle: 'Notificacao automatica do Guardian Sovereign',
            facts,
            markdown: true,
        }],
    };

    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(card),
        });
        if (!res.ok) throw new Error(`Teams webhook status ${res.status}`);
        logger.info('Notificacao Teams enviada com sucesso.');
        return true;
    } catch (err) {
        logger.error('Erro ao enviar notificacao Teams', err);
        return false;
    }
}

/** Send email notification via Microsoft Graph API */
async function sendEmailNotification(payload: NotificationPayload): Promise<boolean> {
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;
    const tenantId = process.env.GRAPH_TENANT_ID;
    const senderEmail = process.env.NOTIFY_FROM_EMAIL;
    const recipientEmail = process.env.NOTIFY_TO_EMAIL;

    if (!clientId || !clientSecret || !tenantId || !senderEmail || !recipientEmail) {
        logger.info('Graph API email credentials nao configurados — notificacao email ignorada.');
        return false;
    }

    try {
        // Get OAuth token
        const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${encodeURIComponent(clientSecret)}&scope=https://graph.microsoft.com/.default`,
        });
        if (!tokenRes.ok) throw new Error(`Token request failed: ${tokenRes.status}`);
        const tokenData = await tokenRes.json() as { access_token: string };

        // Build HTML email body
        const rows = payload.items.map(i => {
            const color = i.severity === 'critical' ? '#D93036' : i.severity === 'warning' ? '#CF8A12' : '#2D7FF9';
            return `<tr><td style="padding:8px;border-bottom:1px solid #eee"><span style="color:${color};font-weight:600">●</span> ${i.label}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right;font-family:monospace">${i.value}</td></tr>`;
        }).join('');

        const htmlBody = `<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#5746AF">${payload.title}</h2>
            <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
            <p style="color:#9096A2;font-size:12px;margin-top:24px">Enviado automaticamente pelo Guardian Sovereign System.</p>
        </div>`;

        // Send email via Graph API
        const mailRes = await fetch(`https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: {
                    subject: payload.title,
                    body: { contentType: 'HTML', content: htmlBody },
                    toRecipients: [{ emailAddress: { address: recipientEmail } }],
                },
                saveToSentItems: false,
            }),
        });

        if (!mailRes.ok) throw new Error(`Graph sendMail failed: ${mailRes.status}`);
        logger.info(`Email enviado para ${recipientEmail}`);
        return true;
    } catch (err) {
        logger.error('Erro ao enviar email', err);
        return false;
    }
}

/** Timer trigger handler */
export async function guardianNotifyHandler(
    timer: Timer,
    context: InvocationContext
): Promise<void> {
    context.log('Guardian Notify: verificando notificacoes...');

    if (timer.isPastDue) {
        context.log('Timer past due — executando mesmo assim.');
    }

    try {
        const payload = await buildNotifications();

        if (!payload) {
            logger.info('Nenhuma notificacao necessaria hoje.');
            return;
        }

        logger.info(`${payload.items.length} item(ns) para notificar.`);

        // Send via all configured channels in parallel
        const [teamsSent, emailSent] = await Promise.all([
            sendTeamsNotification(payload),
            sendEmailNotification(payload),
        ]);

        if (!teamsSent && !emailSent) {
            logger.warn('Nenhum canal de notificacao configurado (TEAMS_WEBHOOK_URL ou GRAPH_* + NOTIFY_*). Configure para receber alertas.');
        }
    } catch (error) {
        logger.error('Erro no timer de notificacoes', error);
    }
}

// ============ ROUTE ============

app.timer('guardianNotify', {
    // Daily at 8:00 AM (UTC-3 = 11:00 UTC)
    schedule: '0 0 11 * * *',
    handler: guardianNotifyHandler,
});

// Also expose as HTTP endpoint for manual triggering
app.http('guardianNotifyManual', {
    methods: ['POST'],
    route: 'guardianNotify',
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const { requireAuth } = await import('../shared/auth');
        const authResult = await requireAuth(request);
        if ('error' in authResult) return authResult.error;

        const payload = await buildNotifications();
        if (!payload) {
            return { status: 200, jsonBody: { success: true, message: 'Nenhuma notificacao necessaria.' } };
        }

        const [teamsSent, emailSent] = await Promise.all([
            sendTeamsNotification(payload),
            sendEmailNotification(payload),
        ]);

        return {
            status: 200,
            jsonBody: {
                success: true,
                payload,
                channels: { teams: teamsSent, email: emailSent },
            },
        };
    },
});
