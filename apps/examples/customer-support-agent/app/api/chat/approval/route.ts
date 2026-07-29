import { handleApprovalRequest } from '../../../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleApprovalRequest(request);
}
