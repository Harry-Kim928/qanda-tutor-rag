// 환경변수 값에서 BOM(U+FEFF)·앞뒤 공백 제거.
// 키를 복붙할 때 끼어든 BOM이 Authorization 헤더 생성 시
// "Cannot convert argument to a ByteString" 오류를 일으키는 문제를 방지한다.
export function cleanEnv(value: string | undefined): string {
  return (value ?? '')
    .split('')
    .filter((ch) => ch.charCodeAt(0) !== 0xfeff)
    .join('')
    .trim()
}
