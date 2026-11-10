/** Solebase Layer 1 shared types. */
export class SolebaseError extends Error {
    code;
    causeDetail;
    constructor(message, code = 'SOLEBASE_ERROR', causeDetail) {
        super(message);
        this.name = 'SolebaseError';
        this.code = code;
        this.causeDetail = causeDetail;
    }
}
//# sourceMappingURL=types.js.map