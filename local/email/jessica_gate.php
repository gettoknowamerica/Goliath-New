<?php
/**
 * Jessica outbound gate — HARD CODED, NOT CONFIGURABLE.
 *
 * Standing rule after the Wave-1 incident (2026-08-12): five emails went out at
 * 2:10 AM without owner sign-off. There is deliberately NO env flag, NO
 * constructor option and NO override parameter to bypass this. To send, an
 * owner-approved row must exist whose body hash matches the text being sent
 * byte for byte. Edit the text after approval and the hash breaks and the send
 * is refused.
 *
 * Flow: draft() -> owner approves in chat -> approve() -> send().
 */

declare(strict_types=1);

final class OutboundBlocked extends \RuntimeException {}

final class JessicaGate
{
    private \PDO $db;

    public function __construct(\PDO $db)
    {
        $this->db = $db;
    }

    private static function hash(string $subject, string $body): string
    {
        // Normalise whitespace only; content changes must break the hash.
        $norm = preg_replace('/\r\n/', "\n", $subject . "\x00" . $body);
        return hash('sha256', $norm);
    }

    /** Create a draft. Never sends. */
    public function draft(string $to, string $subject, string $body, string $agent = 'jessica'): int
    {
        $st = $this->db->prepare(
            'INSERT INTO email_drafts (recipient, subject, body, body_hash, agent, status, created_at)
             VALUES (:to, :subject, :body, :hash, :agent, "pending_owner_approval", NOW())'
        );
        $st->execute([
            ':to' => $to,
            ':subject' => $subject,
            ':body' => $body,
            ':hash' => self::hash($subject, $body),
            ':agent' => $agent,
        ]);
        return (int) $this->db->lastInsertId();
    }

    /** Owner action only. Approves the EXACT text that was reviewed. */
    public function approve(int $draftId, string $approver, string $subject, string $body): void
    {
        if (strtolower($approver) !== 'mark@markpires.com') {
            throw new OutboundBlocked('Only the owner can approve outbound email.');
        }
        $st = $this->db->prepare(
            'UPDATE email_drafts
                SET status = "approved", approved_by = :by, approved_at = NOW(),
                    body_hash = :hash, subject = :subject, body = :body
              WHERE id = :id AND status = "pending_owner_approval"'
        );
        $st->execute([
            ':by' => $approver,
            ':hash' => self::hash($subject, $body),
            ':subject' => $subject,
            ':body' => $body,
            ':id' => $draftId,
        ]);
        if ($st->rowCount() === 0) {
            throw new OutboundBlocked("Draft {$draftId} is not awaiting approval.");
        }
    }

    /**
     * The ONLY path to Resend. Refuses unless the draft is owner-approved, the
     * hash still matches, the recipient is not on DNC, and it has not been sent.
     */
    public function send(int $draftId): array
    {
        $st = $this->db->prepare('SELECT * FROM email_drafts WHERE id = :id');
        $st->execute([':id' => $draftId]);
        $d = $st->fetch(\PDO::FETCH_ASSOC);

        if (!$d) {
            throw new OutboundBlocked("Draft {$draftId} does not exist.");
        }
        if ($d['status'] !== 'approved') {
            throw new OutboundBlocked("BLOCKED: draft {$draftId} is '{$d['status']}', not owner-approved.");
        }
        if (empty($d['approved_by'])) {
            throw new OutboundBlocked("BLOCKED: draft {$draftId} has no approver on record.");
        }
        if (!hash_equals($d['body_hash'], self::hash($d['subject'], $d['body']))) {
            throw new OutboundBlocked("BLOCKED: draft {$draftId} was edited after approval.");
        }
        if (!empty($d['sent_at'])) {
            throw new OutboundBlocked("BLOCKED: draft {$draftId} was already sent at {$d['sent_at']}.");
        }

        // Per-send DNC re-check, not just at import time.
        $dnc = $this->db->prepare('SELECT 1 FROM dnc_list WHERE email = :e LIMIT 1');
        $dnc->execute([':e' => $d['recipient']]);
        if ($dnc->fetchColumn()) {
            $this->db->prepare('UPDATE email_drafts SET status = "suppressed_dnc" WHERE id = :id')
                     ->execute([':id' => $draftId]);
            throw new OutboundBlocked("BLOCKED: {$d['recipient']} is on the DNC list.");
        }

        $key = getenv('RESEND_API_KEY');
        if (!$key) {
            throw new OutboundBlocked('Resend key missing.');
        }

        $payload = json_encode([
            'from' => 'Mark Pires <mark@markpires.com>',
            'to' => [$d['recipient']],
            'subject' => $d['subject'],
            'html' => $d['body'],
        ]);

        $ch = curl_init('https://api.resend.com/emails');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $key,
                'Content-Type: application/json',
            ],
        ]);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code >= 300) {
            throw new \RuntimeException("Resend rejected the send ({$code}): {$res}");
        }

        $this->db->prepare(
            'UPDATE email_drafts SET status = "sent", sent_at = NOW(), provider_response = :r WHERE id = :id'
        )->execute([':r' => $res, ':id' => $draftId]);

        return ['ok' => true, 'draft_id' => $draftId, 'provider' => json_decode($res, true)];
    }
}
