import { type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
export declare const OFFICE_PANEL_CONTENT_SLOT: "office.content";
export declare const OFFICE_PANEL_PRIMARY_PRIORITY = -200;
export declare const OFFICE_PANEL_FALLBACK_PRIORITY = -100;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SlotMap {
        'office.content': {
            kind: 'single';
            scope: 'session-maybe';
        };
    }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' {
    interface SessionReferenceSourceMap {
        officePanel: unknown;
    }
}
type OfficeContentProps = PropsRuntime<'office.content'> & PropsRenderFactories;
export declare function OfficeConversationContent(props: OfficeContentProps): ReactNode;
export declare const inject: string[];
/** Activate the Office-only root after retaining and validating its exact Session. */
export declare function apply(ctx: Context): Promise<void>;
export {};
